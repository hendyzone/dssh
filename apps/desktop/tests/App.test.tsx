import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { deleteServer, loadServers } from "../src/store";
import { loadWorkspace, saveWorkspace } from "../src/lib/workspaceRestore";
import { StrictMode, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const terminalMock = vi.hoisted(() => ({ connected: false }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    close: vi.fn(),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/store", () => ({
  loadServers: async () => [
    {
      id: "server",
      name: "测试服务器",
      host: "example.com",
      port: 22,
      username: "root",
      authMethod: "password",
    },
  ],
  loadSettings: () => ({
    themeId: "tokyo-night",
    fontSize: 14,
    fontFamily: "monospace",
  }),
  saveSettings: vi.fn(),
  upsertServer: vi.fn(),
  deleteServer: vi.fn(),
}));
vi.mock("../src/components/TerminalView", () => ({
  default: ({
    active,
    inputEnabled = true,
    session,
    onBackendReady,
  }: {
    active: boolean;
    inputEnabled?: boolean;
    session: { id: string };
    onBackendReady: (id: string, backend: string) => void;
  }) => {
    useEffect(() => {
      if (terminalMock.connected) onBackendReady(session.id, `ssh-${session.id}`);
    }, [session.id, onBackendReady]);
    return (
    <div className="terminal-view">
      <textarea
        aria-label="Terminal input"
        data-active={active}
        data-enabled={inputEnabled}
      />
    </div>
    );
  },
}));
vi.mock("../src/components/MonitorBar", () => ({ default: () => null }));
vi.mock("../src/components/SftpPanel", () => ({ default: () => null }));
vi.mock("../src/components/ForwardPanel", () => ({ default: () => null }));

beforeEach(() => {
  terminalMock.connected = false;
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
  vi.mocked(deleteServer).mockReset().mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

it("opens and splits a local terminal without creating an SSH connection", async () => {
  localStorage.clear();
  const view = render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "打开本地终端" }));
  expect(screen.getAllByLabelText("Terminal input")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "左右分屏" }));
  expect(screen.getAllByLabelText("Terminal input")).toHaveLength(2);
  expect(loadWorkspace([]).tabs[0].panes.every(p => p.server.kind === "local")).toBe(true);
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "ssh_connect")).toBe(false);
  view.unmount();
});

it("routes an AI notification to the exact tmux pane with the backend request contract", async () => {
  terminalMock.connected = true;
  const servers = await loadServers();
  const remote = { id: "$7", created: 123, name: "agent", pane: "%9" };
  const task = { id: "a".repeat(64), provider: "codex", phase: "waiting", updated: 100, revision: "1", tmux: remote };
  vi.mocked(invoke).mockImplementation(async command => command === "ai_status" ? [task] : []);
  saveWorkspace({ tabs: [{ id: "saved", activePane: 0, panes: [{ id: "one", server: servers[0], tmux: remote }] }],
    activeTabId: "saved", groups: [], cwds: {} });
  const view = render(<App />);
  await act(async () => {});
  await act(async () => window.dispatchEvent(new CustomEvent("dssh-open-task", { detail: `ai:server:${task.id}` })));
  expect(invoke).toHaveBeenCalledWith("tmux_action", { sessionId: "ssh-one", request: {
    action: "select-pane", session: { id: "$7", created: 123 }, target: "%9",
  } });
  expect(view.container.querySelectorAll(".tab")).toHaveLength(1);
  expect(view.container.querySelector(".tab.active")).toBeTruthy();
});

it("restores the workspace after server loading even in StrictMode and persists changes across reopening", async () => {
  const servers = await loadServers();
  saveWorkspace({
    tabs: [{ id: "saved", customTitle: "恢复的工作", splitDir: "column", activePane: 1,
      panes: [{ id: "one", server: servers[0] }, { id: "two", server: servers[0], tmux: { id: "$7", created: 123, name: "agent" } }] }],
    activeTabId: "saved", groups: [], cwds: { one: "/repo" },
  });
  const first = render(<StrictMode><App /></StrictMode>);
  await act(async () => {});
  expect(first.container.querySelectorAll(".tab")).toHaveLength(1);
  expect(first.container.querySelectorAll(".pane")).toHaveLength(2);
  expect((first.container.querySelector(".panes") as HTMLElement).style.flexDirection).toBe("column");
  expect(first.container.querySelectorAll(".pane")[1].classList.contains("focused")).toBe(true);
  expect(loadWorkspace(servers).tabs[0].panes[1].tmux).toEqual({ id: "$7", created: 123, name: "agent" });
  fireEvent.doubleClick(first.container.querySelector(".server-item")!);
  first.unmount();
  const reopened = render(<App />);
  await act(async () => {});
  expect(reopened.container.querySelectorAll(".tab")).toHaveLength(2);
  expect(reopened.container.querySelectorAll(".pane")).toHaveLength(3);
  expect(reopened.container.querySelector(".tab")?.textContent).toContain("恢复的工作");
});

it("reports damaged workspace data without overwriting it on startup", async () => {
  localStorage.setItem("dssh.workspace.v1", "broken");
  render(<App />);
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("工作现场恢复失败");
  expect(localStorage.getItem("dssh.workspace.v1")).toBe("broken");
});

it("requires explicit confirmation before deleting a saved connection", async () => {
  const { container } = await setup();
  fireEvent.click(screen.getByTitle("删除"));
  expect(screen.getByRole("dialog", { name: "删除保存的连接" })).toBeTruthy();
  expect(screen.getByRole("dialog").textContent).toContain("root@example.com:22");
  expect(deleteServer).not.toHaveBeenCalled();
  expect(
    container
      .querySelector(".terminal-view textarea")
      ?.getAttribute("data-enabled"),
  ).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(deleteServer).not.toHaveBeenCalled();
  expect(container.querySelectorAll(".tab")).toHaveLength(2);
  fireEvent.click(screen.getByTitle("删除"));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "确认删除" })),
  );
  expect(deleteServer).toHaveBeenCalledExactlyOnceWith("server");
  expect(container.querySelectorAll(".server-item")).toHaveLength(0);
  expect(container.querySelectorAll(".tab")).toHaveLength(0);
});

it("keeps the connection and displays deletion errors for retry", async () => {
  const { container } = await setup();
  vi.mocked(deleteServer).mockRejectedValueOnce(new Error("保存失败"));
  fireEvent.click(screen.getByTitle("删除"));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "确认删除" })),
  );
  expect(screen.getByRole("alert").textContent).toContain("保存失败");
  expect(container.querySelectorAll(".server-item")).toHaveLength(1);
  expect(container.querySelectorAll(".tab")).toHaveLength(2);
});

async function setup() {
  const view = render(<App />);
  await act(async () => {});
  const item = view.container.querySelector(".server-item")!;
  fireEvent.doubleClick(item);
  fireEvent.doubleClick(item);
  return view;
}

const key = (target: Element | Window, init: KeyboardEventInit) =>
  fireEvent.keyDown(target, init);

it("cycles tabs in both directions including reverse wraparound", async () => {
  const { container } = await setup();
  const tabs = () => Array.from(container.querySelectorAll(".tab"));
  key(window, { key: "1", ctrlKey: true });
  expect(tabs()[0].classList.contains("active")).toBe(true);
  // Three tabs distinguish forward from backward traversal.
  fireEvent.doubleClick(container.querySelector(".server-item")!);
  key(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  expect(tabs()[1].classList.contains("active")).toBe(true);
  key(window, { key: "1", ctrlKey: true });
  key(window, { key: "Tab", ctrlKey: true, shiftKey: true });
  expect(tabs()[2].classList.contains("active")).toBe(true);
  key(window, { key: "Tab", ctrlKey: true });
  expect(tabs()[0].classList.contains("active")).toBe(true);
});

it("does not close sessions from ordinary input controls", async () => {
  const { container } = await setup();
  key(container.querySelector(".sidebar-search input")!, {
    key: "w",
    ctrlKey: true,
  });
  expect(container.querySelectorAll(".tab")).toHaveLength(2);
});

it("blocks page select-all while preserving input and terminal shortcuts", async () => {
  const { container } = await setup();
  const selectAll = { key: "a", ctrlKey: true };
  expect(key(container.querySelector(".server-item")!, selectAll)).toBe(false);
  expect(key(window, { key: "a", metaKey: true })).toBe(false);
  expect(
    key(container.querySelector(".sidebar-search input")!, selectAll),
  ).toBe(true);
  expect(
    key(container.querySelector(".terminal-view textarea")!, selectAll),
  ).toBe(true);
  // The guard also applies while a dialog is open, before its shortcut exemptions.
  key(window, { key: "t", ctrlKey: true });
  expect(key(document.body, selectAll)).toBe(false);
});

it("ignores application keys during IME composition", async () => {
  const { container } = await setup();
  key(window, { key: "w", ctrlKey: true, isComposing: true });
  key(window, { key: "w", ctrlKey: true, keyCode: 229 } as KeyboardEventInit);
  expect(container.querySelectorAll(".tab")).toHaveLength(2);
});

it("suspends terminal input and session shortcuts while the picker is open", async () => {
  const { container } = await setup();
  key(window, { key: "t", ctrlKey: true });
  expect(document.activeElement).toBe(
    document.querySelector(".server-picker-item"),
  );
  expect(
    screen
      .getAllByLabelText("Terminal input")
      .every((input) => input.getAttribute("data-enabled") === "false"),
  ).toBe(true);
  key(window, { key: "w", ctrlKey: true });
  expect(container.querySelectorAll(".tab")).toHaveLength(2);
  key(window, { key: "Escape" });
  expect(
    screen
      .getAllByLabelText("Terminal input")
      .every((input) => input.getAttribute("data-enabled") === "true"),
  ).toBe(true);
});

it("settings supports Escape without letting IME cancellation close it", async () => {
  const { container } = await setup();
  fireEvent.click(screen.getByTitle("设置"));
  const modal = document.querySelector(".modal")!;
  expect(modal.contains(document.activeElement)).toBe(true);
  key(document.activeElement!, { key: "Escape", isComposing: true });
  expect(document.querySelector(".modal")).toBeTruthy();
  key(document.activeElement!, { key: "Escape" });
  expect(document.querySelector(".modal")).toBeNull();
});

it("does not commit or cancel tab rename while choosing an IME candidate", async () => {
  const { container } = await setup();
  fireEvent.doubleClick(
    container.querySelector(".tab.active > span:nth-child(2)")!,
  );
  const input = container.querySelector(".tab-title-input")!;
  fireEvent.change(input, { target: { value: "生产环境" } });
  key(input, { key: "Enter", isComposing: true });
  expect(container.querySelector(".tab-title-input")).toBe(input);
  key(input, { key: "Escape", isComposing: true });
  expect(container.querySelector(".tab-title-input")).toBe(input);
  key(input, { key: "Enter" });
  expect(container.querySelector(".tab.active")!.textContent).toContain(
    "生产环境",
  );
});

it("handles terminal application shortcuts before they can reach a remote encoder", async () => {
  const { container } = await setup();
  const input = screen.getAllByLabelText("Terminal input")[1];
  const encodeRemote = vi.fn();
  input.addEventListener("keydown", encodeRemote);
  key(input, { key: "t", ctrlKey: true });
  expect(encodeRemote).not.toHaveBeenCalled();
  expect(document.querySelector(".server-picker")).toBeTruthy();
});

it("leaves normal terminal control keys to the remote encoder", async () => {
  await setup();
  const input = screen.getAllByLabelText("Terminal input")[1];
  const encodeRemote = vi.fn();
  input.addEventListener("keydown", encodeRemote);
  expect(key(input, { key: "c", ctrlKey: true })).toBe(true);
  expect(key(input, { key: "d", ctrlKey: true })).toBe(true);
  expect(encodeRemote).toHaveBeenCalledTimes(2);
});
