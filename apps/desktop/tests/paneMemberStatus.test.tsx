import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import App from "../src/App";
import MonitorBar from "../src/components/MonitorBar";
import { loadServers } from "../src/store";
import { saveWorkspace } from "../src/lib/workspaceRestore";
import { clearBoardCache, defaultLookupSettings, saveLookupSettings } from "../src/lib/taskLookup";
import { sessionTeamMember, sessionTeamProject } from "../src/lib/tmuxGroups";

// Only the data sources are stubbed (team service snapshot, board HTTP); the pane → member mapping
// and the status pipeline are the production ones the team panel uses.
const teamServiceMock = vi.hoisted(() => ({ url: "", projects: [] as string[], status: { state: "online", token_configured: true }, snapshots: {} as Record<string, unknown> }));
vi.mock("../src/lib/teamService", () => ({ useTeamService: () => teamServiceMock }));
const officeSnapshot = vi.hoisted(() => ({ version: 1, themeId: "one-light", animationEnabled: true, mailAvailability: "unavailable", projects: [] }));
vi.mock("../src/lib/useOfficeMail", () => ({ useOfficeMail: () => undefined }));
vi.mock("../src/lib/useTeamOffice", () => ({ useTeamOffice: () => officeSnapshot }));
vi.mock("../src/lib/officeWindowSync", () => ({ useOfficePresence: () => false, useMainWindowVisibility: () => true, useOfficePublisher: () => {}, openOfficeWindow: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, close: vi.fn() }) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue([]) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/store", () => ({
  loadServers: async () => [{ id: "server", name: "测试服务器", host: "example.com", port: 22, username: "root", authMethod: "password" }],
  loadSettings: () => ({ themeId: "tokyo-night", fontSize: 14, fontFamily: "monospace" }),
  saveSettings: vi.fn(), upsertServer: vi.fn(), deleteServer: vi.fn(),
}));
vi.mock("../src/components/TerminalView", () => ({
  default: ({ session, onBackendReady }: { session: { id: string }; onBackendReady: (id: string, backend: string) => void }) => {
    useEffect(() => { onBackendReady(session.id, `ssh-${session.id}`); }, [session.id, onBackendReady]);
    return <div className="terminal-view" data-testid={`terminal-${session.id}`}/>;
  },
}));

const server = { id: "server", name: "测试服务器", host: "example.com", port: 22, username: "root", authMethod: "password" as const };
const builderTmux = { id: "$31", created: 31, name: "worker-alpha-cw1-claude" };
const idleTmux = { id: "$32", created: 32, name: "worker-alpha-cw2-codex" };
const member = (email: string, tmux: typeof builderTmux, currentTask: string) => ({
  project: "alpha", email, role: "worker", host: server.host, port: server.port, username: server.username, workdir: `/srv/${tmux.name}`, tmux, currentTask,
});
const builder = member("alpha-cw1@example.invalid", builderTmux, "工作中 · alpha/T8");
const idler = member("alpha-cw2@example.invalid", idleTmux, "空闲，等派活");
const report = (key: string, state: string) => ({ key, match: "exact", state, detail: "", at: new Date().toISOString(), since: new Date().toISOString() });
const board = (path: string) => {
  if (path === "/api/v1/agent-sessions") return { sessions: [], now: Math.floor(Date.now() / 1000) };
  if (path === "/api/v1/projects") return { projects: [{ slug: "alpha", name: "Alpha" }] };
  if (path === "/api/v1/projects/alpha/tasks") return { tasks: [{ code: "T8", title: "左右侧栏重构", status_key: "doing", assignee: "alpha-cw1", updated_at: "" }] };
  if (path === "/api/v1/projects/alpha/statuses") return { statuses: [{ key: "doing", name: "进行中" }] };
  if (path === "/api/v1/projects/alpha/tasks/T8") return { code: "T8", title: "左右侧栏重构", status_key: "doing", assignee: "alpha-cw1" };
  if (path === "/api/v1/projects/alpha/tasks/T8/dependencies") return { dependencies: [] };
  return null;
};

beforeEach(async () => {
  localStorage.clear(); clearBoardCache();
  teamServiceMock.url = "https://team.example.invalid/api/v1"; teamServiceMock.projects = ["alpha"];
  teamServiceMock.snapshots = { alpha: { project: "alpha", seq: 1, lseq: 1, members: [builder, idler], ai: {},
    live: { [builder.email]: report(builder.email, "stuck"), [idler.email]: report(idler.email, "idle") }, machines: {}, offline: false, status: "online", identity: "alpha" } };
  saveLookupSettings({ ...defaultLookupSettings(), boardUrl: "https://board.example.invalid" });
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    if (command !== "taskboard_get") return [];
    const body = board((args as { path: string }).path);
    return body ? { status: 200, body: JSON.stringify(body) } : { status: 404, body: "" };
  });
  const servers = await loadServers();
  saveWorkspace({ tabs: [
    { id: "split", activePane: 0, panes: [{ id: "builder-pane", server: servers[0], tmux: builderTmux }, { id: "plain-pane", server: servers[0] }] },
    { id: "idle-tab", activePane: 0, panes: [{ id: "idle-pane", server: servers[0], tmux: idleTmux }] },
  ], activeTabId: "split", groups: [], cwds: {} });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const bar = () => document.querySelector<HTMLElement>(".session-body:not([hidden]) .monitor-bar")!;
const segment = () => within(bar()).queryByRole("group", { name: /^当前窗格/ });
async function renderApp() {
  const view = render(<App/>);
  await act(async () => {});
  await waitFor(() => expect(segment()).toBeTruthy());
  return view;
}

it("shows the active member pane's status dot, name and card in the middle of the status bar", async () => {
  await renderApp();
  const group = segment()!;
  // Board says T8 is doing, the team service says stuck: the team panel reads 「卡住 · 工作中」.
  await waitFor(() => expect(within(group).getByRole("img").getAttribute("aria-label")).toBe("卡住 · 工作中"));
  expect(within(group).getByRole("img").className).toContain("is-bad");
  expect(within(group).getByRole("button", { name: "alpha-cw1" })).toBeTruthy();
  expect(within(group).getByRole("button", { name: "alpha/T8" })).toBeTruthy();
  expect(group.closest(".monitor-center")?.parentElement).toBe(bar());
  expect(group.textContent).not.toMatch(/成员|卡号/);
});

it("updates immediately on pane and tab switches and hides for non-member panes", async () => {
  const { container } = await renderApp();
  expect(within(segment()!).getByRole("button", { name: "alpha-cw1" })).toBeTruthy();
  fireEvent.click(screen.getByTestId("terminal-plain-pane"));
  await waitFor(() => expect(segment()).toBeNull());
  expect(bar()).toBeTruthy();
  fireEvent.click(screen.getByTestId("terminal-builder-pane"));
  await waitFor(() => expect(within(segment()!).getByRole("button", { name: "alpha-cw1" })).toBeTruthy());
  fireEvent.click(container.querySelectorAll(".tab")[1]);
  await waitFor(() => expect(within(segment()!).getByRole("button", { name: "alpha-cw2" })).toBeTruthy());
  expect(within(segment()!).queryByRole("button", { name: "alpha-cw1" })).toBeNull();
});

it("shows only the name when currentTask has no card", async () => {
  const { container } = await renderApp();
  fireEvent.click(container.querySelectorAll(".tab")[1]);
  await waitFor(() => expect(within(segment()!).getByRole("button", { name: "alpha-cw2" })).toBeTruthy());
  expect(within(segment()!).getAllByRole("button")).toHaveLength(1);
  await waitFor(() => expect(within(segment()!).getByRole("img").getAttribute("aria-label")).toBe("空闲·可派活"));
});

it("opens the card through the task card overlay when the card is clicked", async () => {
  await renderApp();
  fireEvent.click(within(segment()!).getByRole("button", { name: "alpha/T8" }));
  const dialog = await screen.findByRole("dialog", { name: "任务详情" });
  expect(await within(dialog).findByText("左右侧栏重构")).toBeTruthy();
  expect(within(dialog).getByText("任务 · alpha")).toBeTruthy();
  expect(vi.mocked(invoke)).toHaveBeenCalledWith("taskboard_get", expect.objectContaining({ path: "/api/v1/projects/alpha/tasks/T8" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "关闭任务详情" }));
  expect(screen.queryByRole("dialog", { name: "任务详情" })).toBeNull();
});

it("opens the team panel located on the member when the name is clicked, with the same status dot", async () => {
  const { container } = await renderApp();
  fireEvent.click(container.querySelectorAll(".tab")[1]);
  await waitFor(() => expect(within(segment()!).getByRole("button", { name: "alpha-cw2" })).toBeTruthy());
  await waitFor(() => expect(within(segment()!).getByRole("img").getAttribute("aria-label")).toBe("空闲·可派活"));
  expect(screen.queryByRole("button", { name: "关闭团队" })).toBeNull();
  fireEvent.click(within(segment()!).getByRole("button", { name: "alpha-cw2" }));
  await screen.findByRole("button", { name: "关闭团队" });
  // The row lands in 「空闲·可派活」, a folded group, once the panel's own board poll arrives:
  // locating keeps that group and the row unfolded and focused, with the status bar's dot.
  await waitFor(() => {
    const row = container.querySelector<HTMLDetailsElement>(`.team-dynamics [data-member-key="${idler.email}"]`)!;
    const group = row.closest(".team-live-group")!;
    expect(group.className).toContain("team-live-group-available");
    expect(group.querySelector("details")?.open).toBe(true);
    expect(row.open).toBe(true);
    expect(document.activeElement).toBe(row.querySelector("summary"));
    expect(row.querySelector(".team-live-dot")?.className).toBe(within(segment()!).getByRole("img").className);
  });
});

it("maps a pane to a roster member with the same identity rule as the team project", () => {
  const service = { projects: ["alpha", "beta"], snapshots: {
    alpha: { members: [builder, idler] },
    beta: { members: [{ ...builder, project: "beta", tmux: { ...builderTmux, id: "$99" } }] },
  } };
  const pane = { server, tmux: builderTmux };
  expect(sessionTeamMember(pane, service)).toEqual({ project: "alpha", member: builder });
  expect(sessionTeamProject(pane, service)).toBe("alpha");
  // Another incarnation (tmux restarted) or another endpoint with a different session name is not the member.
  expect(sessionTeamMember({ server, tmux: { ...builderTmux, created: 77 } }, service)).toBeUndefined();
  expect(sessionTeamMember({ server: { ...server, host: "other.example.com" }, tmux: { ...builderTmux, name: "renamed" } }, service)).toBeUndefined();
  expect(sessionTeamMember({ server }, service)).toBeUndefined();
  // The same incarnation in two teams is ambiguous for both the project and the member.
  const twice = { ...service, snapshots: { ...service.snapshots, beta: { members: [{ ...builder, project: "beta" }] } } };
  expect(sessionTeamProject(pane, twice)).toBeUndefined();
  expect(sessionTeamMember(pane, twice)).toBeUndefined();
});

it("puts the centre slot between the live monitor and 「监控详情」 without replacing either", async () => {
  render(<MonitorBar backendId="backend" detailsOpen onDetailsToggle={() => {}} center={<span>中间</span>}/>);
  await act(async () => {});
  const monitor = document.querySelector<HTMLElement>(".monitor-bar")!;
  const children = [...monitor.children];
  const centre = children.findIndex(child => child.classList.contains("monitor-center"));
  expect(children[centre].textContent).toBe("中间");
  expect(children.findIndex(child => child.getAttribute("aria-label") === "停止监控")).toBeLessThan(centre);
  expect(children.findIndex(child => child.textContent?.startsWith("监控详情"))).toBe(centre + 1);
});
