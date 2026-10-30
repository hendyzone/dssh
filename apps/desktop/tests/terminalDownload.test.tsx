import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import TerminalView from "../src/components/TerminalView";
import { LOCAL_SHELL } from "../src/lib/localShell";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), instances: [] as any[], callbacks: new Map<string, (event: {payload: any}) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({ default: "test.wasm" }));
vi.mock("ghostty-web", () => ({
  init: vi.fn(),
  FitAddon: class { observeResize() {} fit() {} },
  Terminal: class {
    options: any; root?: HTMLElement; data?: (text: string) => void;
    cols = 80; rows = 24; selection = "";
    constructor(options: any) { this.options = options; mocks.instances.push(this); }
    loadAddon() {}
    open(root: HTMLElement) {
      this.root = root;
      root.innerHTML = '<textarea aria-label="Terminal input"></textarea><canvas></canvas>';
      this.focus();
    }
    focus() {}
    write = vi.fn();
    scrollToBottom = vi.fn();
    getSelection = vi.fn(() => this.selection);
    hasMouseTracking = vi.fn(() => false);
    pastedData = vi.fn(); paste = this.pastedData; selectAll = vi.fn();
    attachCustomWheelEventHandler = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    onData(callback: (text: string) => void) { this.data = callback; return {dispose() {}}; }
    onResize() { return {dispose() {}}; }
    onRender() { return {dispose() {}}; }
    dispose() {}
  },
}));

const props = {
  active: true, inputEnabled: true,
  settings: {themeId: "tokyo-night", fontSize: 14, fontFamily: "monospace"},
  onBackendReady: vi.fn(),
};
const remote = {id: "pane", server: {id: "server", name: "server", host: "example.com", port: 22, username: "root", authMethod: "password" as const}};
const entries = (...list: {path: string; isDir?: boolean}[]) => list.map(item => ({name: item.path.split("/").pop(), path: item.path, isDir: Boolean(item.isDir), size: 10}));

const openMenu = async (view: ReturnType<typeof render>, selection: string) => {
  mocks.instances.at(-1)!.selection = selection;
  await waitFor(() => expect(mocks.instances.length).toBeGreaterThan(0));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
  const target = view.container.querySelector(".terminal-view")!.firstElementChild!;
  await act(async () => { fireEvent.contextMenu(target, {clientX: 10, clientY: 10}); });
  await act(async () => {});
};
const downloadItem = () => screen.queryByRole("menuitem", {name: "下载"});

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.callbacks.clear();
  mocks.listen.mockImplementation(async (event: string, callback: (event: {payload: any}) => void) => {
    mocks.callbacks.set(event, callback);
    return () => {};
  });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "ssh_connect") return "backend";
    if (command === "local_connect") return "local-backend";
    if (command === "sftp_list") return entries({path: "/srv/report.zip"}, {path: "/srv/work/clips/a.zip"}, {path: "/srv/dir", isDir: true});
    if (command === "sftp_download") return "/home/me/report.zip";
    return undefined;
  });
});

it("downloads the selected absolute path through the existing SFTP transfer, then reveals it", async () => {
  const view = render(<TerminalView {...props} session={remote}/>);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ssh_connect", expect.anything()));
  await openMenu(view, "/srv/report.zip");
  const item = await screen.findByRole("menuitem", {name: "下载"}, {timeout: 5000});
  expect(item.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(item);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("sftp_download", {
    sessionId: "backend", remotePath: "/srv/report.zip", transferId: expect.any(String),
  }));
  expect(await screen.findByText(/已下载到 \/home\/me\/report\.zip/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "打开所在目录"}));
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_reveal_local", {path: "/home/me/report.zip"});
  view.unmount();
});

it("resolves a relative selection against the pane's reported cwd", async () => {
  const view = render(<TerminalView {...props} session={{...remote, restoreCwd: "/srv/work"}}/>);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ssh_connect", expect.anything()));
  await openMenu(view, "clips/a.zip");
  await screen.findByRole("menuitem", {name: "下载"}, {timeout: 5000});
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_list", {sessionId: "backend", path: "/srv/work/clips"});
  fireEvent.click(screen.getByRole("menuitem", {name: "下载"}));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("sftp_download", {
    sessionId: "backend", remotePath: "/srv/work/clips/a.zip", transferId: expect.any(String),
  }));
  view.unmount();
});

it("offers no download when the selected path is a directory", async () => {
  const view = render(<TerminalView {...props} session={remote}/>);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ssh_connect", expect.anything()));
  await openMenu(view, "/srv/dir");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("sftp_list", {sessionId: "backend", path: "/srv"}));
  expect(downloadItem()).toBeNull();
  view.unmount();
});

it("offers no download when the selected path does not exist", async () => {
  const view = render(<TerminalView {...props} session={remote}/>);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ssh_connect", expect.anything()));
  await openMenu(view, "/srv/deleted.zip");
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("sftp_list", {sessionId: "backend", path: "/srv"}));
  expect(downloadItem()).toBeNull();
  view.unmount();
});

it("offers no download in a local terminal and never stats the remote host", async () => {
  mocks.invoke.mockClear();
  const view = render(<TerminalView {...props} session={{id: "local", server: LOCAL_SHELL}}/>);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("local_connect", expect.anything()));
  await openMenu(view, "/srv/report.zip");
  expect(downloadItem()).toBeNull();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "sftp_list")).toBe(false);
  view.unmount();
});
