import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { loadServers } from "../src/store";
import { loadWorkspace, saveWorkspace } from "../src/lib/workspaceRestore";
import { BOOKMARKS_KEY, bookmarkId } from "../src/lib/bookmarks";

const terminalMock = vi.hoisted(() => ({ connected: true }));
vi.mock("../src/lib/teamService", () => ({ useTeamService: () => ({url:"",projects:[],status:{state:"online",token_configured:true},snapshots:{}}) }));
vi.mock("../src/lib/useOfficeMail", () => ({useOfficeMail: () => undefined}));
vi.mock("../src/lib/useTeamOffice", () => ({useTeamOffice: () => ({version:1,themeId:"one-light",animationEnabled:false,mailAvailability:"unavailable",projects:[]})}));
vi.mock("../src/lib/officeWindowSync", () => ({useOfficePresence:()=>false,useMainWindowVisibility:()=>true,useOfficePublisher:()=>undefined,openOfficeWindow:vi.fn()}));
vi.mock("@tauri-apps/api/event", () => ({listen: async () => () => {}}));
vi.mock("@tauri-apps/api/window", () => ({getCurrentWindow: () => ({onCloseRequested: async () => () => {}, close: vi.fn()})}));
vi.mock("@tauri-apps/api/core", async importOriginal => ({...await importOriginal<typeof import("@tauri-apps/api/core")>(), invoke: vi.fn()}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open: vi.fn()}));
vi.mock("../src/store", () => ({
  loadServers: async () => [
    {id:"server-a", name:"服务器 A", host:"a.example", port:22, username:"root", authMethod:"password"},
    {id:"server-b", name:"服务器 B", host:"b.example", port:22, username:"root", authMethod:"password"},
  ],
  loadSettings: () => ({themeId:"tokyo-night", fontSize:14, fontFamily:"monospace"}),
  saveSettings: vi.fn(), upsertServer: vi.fn(), deleteServer: vi.fn(),
}));
vi.mock("../src/components/MonitorBar", () => ({default: () => null}));
vi.mock("../src/components/SftpPanel", () => ({default: () => null}));
vi.mock("../src/components/ForwardPanel", () => ({default: () => null}));
vi.mock("../src/components/TerminalView", () => ({
  default: ({active, session, onBackendReady, onOpenPage}: {
    active: boolean; session: {id:string};
    onBackendReady: (id:string, backend:string) => void;
    onOpenPage?: (target:{kind:"html"|"markdown"|"image";path:string}, sessionId:string) => void;
  }) => (
    <div className="terminal-view" data-testid={`terminal-${session.id}`} data-active={String(active)}>
      <button onClick={() => onOpenPage?.({kind:"markdown", path:"/srv/report.md"}, `ssh-${session.id}`)}>预览远程文件</button>
      <textarea aria-label={`终端 ${session.id}`} readOnly/>
      {terminalMock.connected && <button aria-label={`连接 ${session.id}`} onClick={() => onBackendReady(session.id, `ssh-${session.id}`)}>连接</button>}
    </div>
  ),
}));

const file = "/srv/report.md";
const seed = async (pagesOn?: "server-b") => {
  const servers = await loadServers();
  const tabs = [{id:"tab-a", activePane:0, panes:[{id:"pane-a", server:servers[0]}]}];
  if (pagesOn === "server-b") tabs.push({id:"tab-b", activePane:0, panes:[{id:"pane-b", server:servers[1]}]});
  saveWorkspace({tabs, activeTabId:"tab-a", groups:[], cwds:{}});
  return servers;
};
const connect = async (view: ReturnType<typeof render>, paneId: string) => {
  const button = view.container.querySelector(`[aria-label="连接 ${paneId}"]`) as HTMLButtonElement;
  await act(async () => { fireEvent.click(button); });
};
const openFile = async (view: ReturnType<typeof render>, tabKey = "pane-a") => {
  const terminal = view.container.querySelector(`[data-testid="terminal-${tabKey}"]`) as HTMLElement;
  await act(async () => { fireEvent.click(within(terminal).getByText("预览远程文件")); });
};
const bookmarkButton = () => screen.getByRole("button", {name:"文件书签"});
const openPanel = async () => {
  await act(async () => { fireEvent.click(bookmarkButton()); });
  return screen.getByRole("dialog", {name:"文件书签"});
};

beforeEach(() => {
  localStorage.clear();
  terminalMock.connected = true;
  vi.mocked((globalThis as {invoke?: unknown}).invoke ?? (()=>undefined));
});
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

it("stars an open remote file, keeps it across a remount, and removes it", async () => {
  vi.mocked((await import("@tauri-apps/api/core")).invoke).mockImplementation(async command => command === "sftp_read_text" ? "# Report" : []);
  await seed();
  const view = render(<App/>);
  await act(async () => {});
  await connect(view, "pane-a");
  await openFile(view);
  await screen.findByTitle("report.md", {selector:"iframe"});
  fireEvent.click(screen.getByRole("button", {name:"收藏"}));
  await act(async () => {});
  expect(screen.getByRole("button", {name:"取消收藏"})).toBeTruthy();
  let panel = await openPanel();
  expect(within(panel).getByRole("button", {name:"打开书签 report.md"}).textContent).toContain("服务器 A");
  view.unmount();
  // remount reads localStorage, not React state
  const second = render(<App/>);
  await act(async () => {});
  panel = await openPanel();
  expect(within(panel).getByRole("button", {name:"打开书签 report.md"})).toBeTruthy();
  fireEvent.click(within(panel).getByRole("button", {name:"取消收藏 report.md"}));
  expect(within(panel).queryByRole("button", {name:"打开书签 report.md"})).toBeNull();
  expect(within(panel).getByText("暂无书签")).toBeTruthy();
  second.unmount();
});

it("reopens by saved server and path, switches when already open, and survives a missing server", async () => {
  const invoke = (await import("@tauri-apps/api/core")).invoke as unknown as ReturnType<typeof vi.fn>;
  invoke.mockImplementation(async (command: string) => command === "sftp_read_text" ? "# Report" : []);
  await seed();
  const view = render(<App/>);
  await act(async () => {});
  await connect(view, "pane-a");
  await openFile(view);
  await screen.findByTitle("report.md", {selector:"iframe"});
  fireEvent.click(screen.getByRole("button", {name:"收藏"}));
  // close the page; the bookmark must re-read it through the same server + path
  fireEvent.click(screen.getByRole("button", {name:"关闭网页 report.md"}));
  expect(screen.queryByTitle("report.md", {selector:"iframe"})).toBeNull();
  fireEvent.click(within(await openPanel()).getByRole("button", {name:"打开书签 report.md"}));
  await screen.findByTitle("report.md", {selector:"iframe"});
  const reads = invoke.mock.calls.filter(([command]) => command === "sftp_read_text");
  expect(reads.at(-1)?.[1]).toMatchObject({path:"/srv/report.md", sessionId:"ssh-pane-a"});
  // already open → only switch tabs, never open a second page
  fireEvent.click(within(await openPanel()).getByRole("button", {name:"打开书签 report.md"}));
  expect(view.container.querySelectorAll(".web-page")).toHaveLength(1);

  // deleted server: readable alert, no throw
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([{
    id: bookmarkId("gone", file), serverId:"gone", serverName:"已删的服务器", kind:"markdown", path:file, title:"report.md", addedAt: 1,
  }]));
  view.unmount();
  const missing = render(<App/>);
  await act(async () => {});
  const dialog = await openPanel();
  fireEvent.click(within(dialog).getByRole("button", {name:"打开书签 report.md"}));
  expect(within(dialog).getByRole("alert").textContent).toContain("服务器已不存在：已删的服务器");
  missing.unmount();
});

it("uses the saved server id, not just the path, when another server has the same file open", async () => {
  let reads: string[] = [];
  const invoke = (await import("@tauri-apps/api/core")).invoke as unknown as ReturnType<typeof vi.fn>;
  invoke.mockImplementation(async (command: string, args: {sessionId?: string}) => {
    if (command === "sftp_read_text") { reads.push(args.sessionId ?? ""); return "# Report"; }
    return [];
  });
  await seed("server-b");
  localStorage.setItem(BOOKMARKS_KEY, JSON.stringify([{
    id: bookmarkId("server-a", file), serverId:"server-a", serverName:"服务器 A", kind:"markdown", path:file, title:"report.md", addedAt: 1,
  }]));
  const view = render(<App/>);
  await act(async () => {});
  await connect(view, "pane-a");
  await connect(view, "pane-b");
  // server B already shows the same path; the bookmark for server A must still open its own page
  await openFile(view, "pane-b");
  await waitFor(() => expect(reads).toContain("ssh-pane-b"));
  fireEvent.click(within(await openPanel()).getByRole("button", {name:"打开书签 report.md"}));
  await waitFor(() => expect(reads).toContain("ssh-pane-a"));
  expect(view.container.querySelectorAll(".web-page")).toHaveLength(2);
  view.unmount();
});
