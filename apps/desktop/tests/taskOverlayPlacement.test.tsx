import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import { readFileSync } from "node:fs";
import { invoke } from "@tauri-apps/api/core";
import App from "../src/App";
import TerminalTaskLayer from "../src/components/TerminalTaskLayer";
import { loadServers } from "../src/store";
import { saveWorkspace } from "../src/lib/workspaceRestore";
import { boardSource, clearBoardCache, defaultLookupSettings, saveLookupSettings } from "../src/lib/taskLookup";
import { defaultLayout, setPanelSide, type PanelSide } from "../src/lib/sidePanelLayout";

// dssh/T84: the task detail overlay sits in the terminal area's top-left corner in every layout
// (connections sidebar left/right × team panel closed/open, either dock side). The placement is
// pure CSS — the overlay is absolutely positioned inside the terminal area — so these tests load
// the production stylesheets into jsdom and read the cascade instead of stubbing any position code.
// Only the data sources are stubbed (team service snapshot, board HTTP, terminal backend).

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
const settingsMock = vi.hoisted(() => ({ panelLayout: undefined as unknown }));
vi.mock("../src/store", () => ({
  loadServers: async () => [{ id: "server", name: "测试服务器", host: "example.com", port: 22, username: "root", authMethod: "password" }],
  loadSettings: () => ({ themeId: "tokyo-night", fontSize: 14, fontFamily: "monospace", panelLayout: settingsMock.panelLayout }),
  saveSettings: vi.fn(), upsertServer: vi.fn(), deleteServer: vi.fn(),
}));
vi.mock("../src/components/TerminalView", () => ({
  default: ({ session, onBackendReady }: { session: { id: string }; onBackendReady: (id: string, backend: string) => void }) => {
    useEffect(() => { onBackendReady(session.id, `ssh-${session.id}`); }, [session.id, onBackendReady]);
    return <div className="terminal-view" data-testid={`terminal-${session.id}`}/>;
  },
}));

// ---- production stylesheets ----------------------------------------------------------------
/** jsdom's CSSOM drops `@layer name { … }` blocks wholesale; unwrap them so the rules inside still cascade. */
function unlayer(css: string): string {
  let out = css;
  for (let at = out.search(/@layer\s+[\w-]+\s*\{/); at >= 0; at = out.search(/@layer\s+[\w-]+\s*\{/)) {
    const open = out.indexOf("{", at);
    let depth = 1, close = open + 1;
    for (; close < out.length && depth; close++) {
      if (out[close] === "{") depth++;
      else if (out[close] === "}") depth--;
    }
    out = out.slice(0, at) + out.slice(open + 1, close - 1) + out.slice(close);
  }
  return out;
}
const productionCss = ["../src/style.css", "../src/components/TaskLookup.css"]
  .map(path => unlayer(readFileSync(new URL(path, import.meta.url), "utf8"))).join("\n");
function installProductionCss() {
  const style = document.createElement("style");
  style.dataset.test = "production-css";
  style.textContent = productionCss;
  document.head.appendChild(style);
}

const positioned = (el: Element) => !["", "static"].includes(getComputedStyle(el).position);
/** The element an absolutely positioned box is laid out against: its nearest positioned ancestor. */
function containingBlock(el: Element): HTMLElement | null {
  for (let at = el.parentElement; at; at = at.parentElement) if (positioned(at)) return at;
  return null;
}
function expectTopLeftAnchor(overlay: HTMLElement) {
  const style = getComputedStyle(overlay);
  expect(style.position).toBe("absolute");
  expect(style.top).toBe("12px");
  expect(style.left).toBe("12px");
  // Anchoring to the right edge as well would stretch or flip the box; it must be left-only.
  expect(["", "auto"]).toContain(style.right);
}

// ---- fixtures (same team/board shape as paneMemberStatus.test.tsx) ---------------------------
const server = { id: "server", name: "测试服务器", host: "example.com", port: 22, username: "root", authMethod: "password" as const };
const builderTmux = { id: "$31", created: 31, name: "worker-alpha-cw1-claude" };
const builder = { project: "alpha", email: "alpha-cw1@example.invalid", role: "worker", host: server.host, port: server.port,
  username: server.username, workdir: `/srv/${builderTmux.name}`, tmux: builderTmux, currentTask: "工作中 · alpha/T8" };
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
const boardInvoke = async (command: string, args?: unknown) => {
  if (command !== "taskboard_get") return [];
  const body = board((args as { path: string }).path);
  return body ? { status: 200, body: JSON.stringify(body) } : { status: 404, body: "" };
};

beforeEach(() => {
  localStorage.clear(); clearBoardCache();
  installProductionCss();
  saveLookupSettings({ ...defaultLookupSettings(), boardUrl: "https://board.example.invalid" });
  vi.mocked(invoke).mockReset().mockImplementation(boardInvoke as typeof invoke);
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks();
  document.head.querySelectorAll("style[data-test=production-css]").forEach(node => node.remove());
});

describe("task overlay sits at the terminal area's top-left in every App layout", () => {
  beforeEach(async () => {
    teamServiceMock.url = "https://team.example.invalid/api/v1"; teamServiceMock.projects = ["alpha"];
    teamServiceMock.snapshots = { alpha: { project: "alpha", seq: 1, lseq: 1, members: [builder], ai: {},
      live: { [builder.email]: report(builder.email, "busy") }, machines: {}, offline: false, status: "online", identity: "alpha" } };
    const servers = await loadServers();
    saveWorkspace({ tabs: [{ id: "tab", activePane: 0, panes: [{ id: "builder-pane", server: servers[0], tmux: builderTmux }] }],
      activeTabId: "tab", groups: [], cwds: {} });
  });

  const layouts: { name: string; connections: PanelSide; team: "closed" | PanelSide }[] = [
    { name: "connections left · team panel closed", connections: "left", team: "closed" },
    { name: "connections left · team panel open (right dock)", connections: "left", team: "right" },
    { name: "connections right · team panel closed", connections: "right", team: "closed" },
    { name: "connections right · team panel open (right dock)", connections: "right", team: "right" },
    { name: "connections left · team panel open (left dock)", connections: "left", team: "left" },
    { name: "connections right · team panel open (left dock)", connections: "right", team: "left" },
  ];

  it.each(layouts)("$name", async ({ connections, team }) => {
    let layout = setPanelSide(defaultLayout(), "connections", connections);
    if (team !== "closed") layout = setPanelSide(layout, "team", team);
    settingsMock.panelLayout = layout;
    const { container } = render(<App/>);
    await act(async () => {});
    const bar = () => container.querySelector<HTMLElement>(".session-body:not([hidden]) .monitor-bar")!;
    const segment = () => within(bar()).queryByRole("group", { name: /^当前窗格/ });
    await waitFor(() => expect(segment()).toBeTruthy());
    if (team !== "closed") {
      fireEvent.click(within(segment()!).getByRole("button", { name: "alpha-cw1" }));
      await screen.findByRole("button", { name: "关闭团队" });
    }
    fireEvent.click(within(segment()!).getByRole("button", { name: "alpha/T8" }));
    const overlay = await screen.findByRole("dialog", { name: "任务详情" });
    await within(overlay).findByText("左右侧栏重构");

    // The layout under test really is the one rendered.
    const dock = container.querySelector<HTMLElement>(".connections-dock")!;
    expect(dock.classList.contains(`connections-dock-${connections}`)).toBe(true);
    const mainArea = container.querySelector<HTMLElement>(".main-area")!;
    const follows = dock.compareDocumentPosition(mainArea) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(!!follows).toBe(connections === "left");
    const teamDock = container.querySelector<HTMLElement>(".session-body:not([hidden]) .panel-dock");
    if (team === "closed") expect(teamDock).toBeNull();
    else expect(teamDock?.classList.contains(`panel-dock-${team}`)).toBe(true);

    // Placement: laid out against the terminal area, anchored top-left inside it.
    const anchor = containingBlock(overlay)!;
    expect(anchor?.className ?? "(no positioned ancestor)").toMatch(/\bpanes\b/);
    expect(anchor.closest(".session-body")?.hasAttribute("hidden")).toBe(false);
    expectTopLeftAnchor(overlay);

    // Never over the connections sidebar or a docked side panel: neither is inside the terminal area
    // the overlay is confined to, and the overlay is not inside either of them.
    expect(anchor.contains(dock)).toBe(false);
    expect(overlay.closest(".connections-dock, .panel-dock")).toBeNull();
    if (teamDock) {
      expect(anchor.contains(teamDock)).toBe(false);
      expect(teamDock.parentElement).toBe(anchor.parentElement);
    }
  });
});

it("anchors the overlay opened from a terminal task link at that pane's top-left", async () => {
  teamServiceMock.url = ""; teamServiceMock.projects = []; teamServiceMock.snapshots = {};
  const source = boardSource({ ...defaultLookupSettings(), boardUrl: "https://board.example.invalid" })!;
  const { container } = render(
    <div className="panes"><div className="pane focused">
      <div className="terminal-view"/>
      <TerminalTaskLayer source={source} project="alpha" hover={null} opened={{ code: "T8", seq: 1 }} onClose={vi.fn()}/>
    </div></div>,
  );
  const overlay = await screen.findByRole("dialog", { name: "任务详情" });
  await within(overlay).findByText("左右侧栏重构");
  expect(containingBlock(overlay)).toBe(container.querySelector(".pane"));
  expectTopLeftAnchor(overlay);
});
