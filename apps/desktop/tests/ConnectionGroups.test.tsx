import { useEffect } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { insertConnection, moveConnection } from "../src/lib/connectionGroups";
import type { TabInfo } from "../src/types";

const tracked = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
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
  loadServers: async () =>
    ["Alpha", "Beta", "Gamma"].map((name) => ({
      id: name,
      name,
      host: "example.com",
      port: 22,
      username: "root",
      authMethod: "password",
    })),
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
  default: function TerminalMock({
    session,
    active,
    inputEnabled,
    onBackendReady,
  }: any) {
    useEffect(() => {
      tracked.mounted(session.id);
      onBackendReady(session.id, `backend-${session.id}`);
      return () => tracked.unmounted(session.id);
    }, [session.id, onBackendReady]);
    return (
      <textarea
        aria-label={`Terminal ${session.server.name}`}
        data-active={active}
        data-enabled={inputEnabled}
      />
    );
  },
}));
vi.mock("../src/components/MonitorBar", () => ({ default: () => null }));
vi.mock("../src/components/SftpPanel", () => ({ default: () => null }));
vi.mock("../src/components/ForwardPanel", () => ({ default: () => null }));
beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
async function setup() {
  const view = render(<App />);
  await act(async () => {});
  for (const item of view.container.querySelectorAll(".server-item"))
    fireEvent.doubleClick(item);
  return view;
}
function tab(name: string) {
  return screen.getByRole("tab", { name: new RegExp(name) });
}
function clickMenuItem(name: string) {
  const item = screen.getByRole("menuitem", { name });
  fireEvent.pointerDown(item, { button: 0, pointerType: "mouse" });
  fireEvent.mouseDown(item, { button: 0 });
  expect(item.isConnected).toBe(true);
  fireEvent.pointerUp(item, { button: 0, pointerType: "mouse" });
  fireEvent.mouseUp(item, { button: 0 });
  fireEvent.click(item);
}
function createGroup(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
  fireEvent.change(screen.getByLabelText("分组名称"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建分组" }));
}
function move(name: string, group: string) {
  fireEvent.contextMenu(tab(name));
  clickMenuItem(`移入：${group}`);
}
it("renames a tab through a full mouse click", async () => {
  await setup();
  const targetTab = tab("Alpha");
  fireEvent.contextMenu(targetTab);
  clickMenuItem("重命名");
  const input = within(targetTab).getByRole("textbox");
  fireEvent.change(input, { target: { value: "工作连接" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(tab("工作连接")).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
});
it("creates a group for the context-clicked tab", async () => {
  await setup();
  fireEvent.contextMenu(tab("Alpha"));
  clickMenuItem("加入新分组…");
  fireEvent.change(screen.getByLabelText("分组名称"), {
    target: { value: "运维" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建分组" }));
  const group = screen.getByRole("button", { name: "管理分组 运维" })
    .closest(".connection-group")!;
  expect(within(group as HTMLElement).getByRole("tab", { name: /Alpha/ })).toBeTruthy();
});
it.each([
  ["关闭其他", ["Beta"]],
  ["关闭右侧", ["Alpha", "Beta"]],
  ["关闭标签", ["Alpha", "Gamma"]],
])("executes %s after mouse down and up", async (action, remaining) => {
  const view = await setup();
  fireEvent.contextMenu(tab("Beta"));
  clickMenuItem(action);
  expect(view.container.querySelectorAll(".tab")).toHaveLength(remaining.length);
  for (const name of remaining) expect(tab(name)).toBeTruthy();
  expect(screen.queryByRole("menu")).toBeNull();
});
it("dismisses the tab menu on an outside pointer press or Escape", async () => {
  await setup();
  fireEvent.contextMenu(tab("Alpha"));
  // Radix registers its outside-pointer listener on the next task.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  fireEvent.pointerDown(document.body, { button: 0, pointerType: "mouse" });
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(tab("Alpha"));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});
it("creates groups, moves connections, collapses and preserves terminal instances", async () => {
  await setup();
  createGroup("生产");
  move("Alpha", "生产");
  expect(tracked.mounted).toHaveBeenCalledTimes(3);
  expect(tracked.unmounted).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "折叠分组 生产" }));
  expect(screen.queryByRole("tab", { name: /Alpha/ })).toBeNull();
  expect(tab("Gamma")).toBeTruthy();
  expect(
    screen.getByLabelText("Terminal Gamma").getAttribute("data-active"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "展开分组 生产" }));
  expect(tab("Alpha")).toBeTruthy();
});
it("renames and recolors groups, then dissolves without disconnecting", async () => {
  await setup();
  createGroup("生产");
  fireEvent.click(screen.getByRole("button", { name: "管理分组 生产" }));
  expect(
    screen.getByLabelText("Terminal Gamma").getAttribute("data-enabled"),
  ).toBe("false");
  fireEvent.change(screen.getByLabelText("分组名称"), {
    target: { value: "数据库" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "绿色" }));
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  expect(
    screen
      .getByRole("button", { name: "管理分组 数据库" })
      .closest(".connection-group")
      ?.getAttribute("style"),
  ).toContain("#73bb87");
  fireEvent.click(screen.getByRole("button", { name: "管理分组 数据库" }));
  fireEvent.click(screen.getByRole("button", { name: "解散分组，保留连接" }));
  expect(screen.queryByRole("button", { name: "管理分组 数据库" })).toBeNull();
  expect(
    screen.getAllByRole("tab", { hidden: true }).filter((el) => el.classList.contains("tab")),
  ).toHaveLength(3);
  expect(tracked.unmounted).not.toHaveBeenCalled();
});
it("closes only group members and honors connection close cancellation", async () => {
  await setup();
  createGroup("生产");
  move("Alpha", "生产");
  fireEvent.click(screen.getByRole("button", { name: "管理分组 生产" }));
  vi.mocked(window.confirm).mockReturnValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "关闭组内全部连接" }));
  expect(
    screen.getAllByRole("tab", { hidden: true }).filter((el) => el.classList.contains("tab")),
  ).toHaveLength(3);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "关闭组内全部连接" }));
  expect(
    screen.getAllByRole("tab", { hidden: true }).filter((el) => el.classList.contains("tab")),
  ).toHaveLength(1);
  expect(tab("Beta").getAttribute("aria-selected")).toBe("true");
  expect(tracked.unmounted).toHaveBeenCalledTimes(2);
});
it("keeps duplicate connections in their source group and supports moving out", async () => {
  await setup();
  createGroup("生产");
  fireEvent.contextMenu(tab("Gamma"));
  clickMenuItem("复制此会话");
  const group = screen
    .getByRole("button", { name: "管理分组 生产" })
    .closest(".connection-group")!;
  expect(within(group as HTMLElement).getAllByRole("tab", { hidden: true })).toHaveLength(2);
  fireEvent.contextMenu(tab("Gamma #2"));
  clickMenuItem("移出分组");
  expect(within(group as HTMLElement).getAllByRole("tab", { hidden: true })).toHaveLength(1);
});
it("does not commit group names or close the dialog during IME composition", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "新建分组" }));
  const input = screen.getByLabelText("分组名称");
  fireEvent.change(input, { target: { value: "生产" } });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.keyDown(window, { key: "w", ctrlKey: true });
  expect(
    screen.getAllByRole("tab", { hidden: true }).filter((el) => el.classList.contains("tab")),
  ).toHaveLength(3);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("moves by drag-and-drop without reconnecting", async () => {
  await setup();
  createGroup("生产");
  const dataTransfer = {
    getData: () => "",
    setData: vi.fn(),
    types: ["application/x-dssh-tab"],
  };
  fireEvent.dragStart(tab("Alpha"), { dataTransfer });
  const id = dataTransfer.setData.mock.calls[0][1];
  dataTransfer.getData = () => id;
  fireEvent.drop(
    screen
      .getByRole("button", { name: "管理分组 生产" })
      .closest(".connection-group")!,
    { dataTransfer },
  );
  expect(
    screen
      .getByRole("button", { name: "管理分组 生产" })
      .closest(".connection-group")!.textContent,
  ).toContain("Alpha");
  expect(tracked.unmounted).not.toHaveBeenCalled();
});
it("keeps visual order and close-right order contiguous when inserting or moving", () => {
  const tabs = [
    { id: "a", groupId: "g" },
    { id: "b", groupId: "g" },
    { id: "c" },
  ] as TabInfo[];
  expect(moveConnection(tabs, "c", "g").map((t) => t.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(
    insertConnection(tabs, { id: "d", groupId: "g" } as TabInfo).map(
      (t) => t.id,
    ),
  ).toEqual(["a", "b", "d", "c"]);
  expect(moveConnection(tabs, "a").map((t) => t.id)).toEqual(["b", "c", "a"]);
  expect(moveConnection(tabs, "missing", "g")).toBe(tabs);
});
