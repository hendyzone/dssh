import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "../src/platform/core";
import { expect, it, vi } from "vitest";
import Sidebar from "../src/components/Sidebar";
import type { ServerEntry } from "../src/types";
vi.mock("../src/platform/core", () => ({ invoke: vi.fn() }));

it("reorders siblings with an insertion line and persists the order without changing server records", async () => {
  const siblings = servers.map(server => ({ ...server, group: undefined }));
  const options = { ...props(), servers: siblings, onServersChanged: vi.fn() };
  const view = render(<Sidebar {...options} />);
  const source = screen.getByLabelText("本地服务，u@local.example:22");
  const target = screen.getByLabelText("测试服务，u@two.example:22");
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: vi.fn(() => target) });
  fireEvent(source, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
  fireEvent(window, new MouseEvent("pointermove", { bubbles: true, clientX: 50, clientY: 50 }));
  expect(target.getAttribute("data-drop")).toBe("after");
  fireEvent(window, new MouseEvent("pointerup", { bubbles: true, clientX: 50, clientY: 50 }));
  await waitFor(() => expect(JSON.parse(localStorage.getItem("dssh.sidebar.tree-layout")!).order[""]).toEqual(["2", "3", "1"]));
  expect(invoke).not.toHaveBeenCalled();
  view.unmount();
  const next = render(<Sidebar {...options} />);
  expect([...next.container.querySelectorAll("[data-tree-server]")].map(element => element.getAttribute("data-tree-server"))).toEqual(["2", "3", "1"]);
  Reflect.deleteProperty(document, "elementFromPoint");
});

it("creates an empty nested folder and restores it after remount", () => {
  const options = props();
  const view = render(<Sidebar {...options} />);
  fireEvent.contextMenu(screen.getByTitle("外网/公司"));
  fireEvent.click(screen.getByRole("menuitem", { name: "新建子文件夹" }));
  fireEvent.change(screen.getByLabelText("文件夹名称"), {
    target: { value: "新门店" },
  });
  fireEvent.click(screen.getByRole("button", { name: "创建" }));
  expect(screen.getByTitle("外网/公司/新门店")).toBeTruthy();
  view.unmount();
  render(<Sidebar {...options} />);
  expect(screen.getByRole("button", { name: /新门店.*0/ })).toBeTruthy();
});

it("moves a connection by pointer drop using only id and destination group", async () => {
  const changed = vi.fn();
  vi.mocked(invoke).mockResolvedValueOnce(
    servers.map((server) =>
      server.id === "3" ? { ...server, group: "外网/公司" } : server,
    ),
  );
  render(<Sidebar {...props()} onServersChanged={changed} />);
  const source = screen.getByLabelText("本地服务，u@local.example:22");
  const target = screen.getByTitle("外网/公司");
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => target),
  });
  const pointer = (element: Element | Window, type: string, x: number) =>
    fireEvent(
      element,
      new MouseEvent(type, {
        bubbles: true,
        button: 0,
        clientX: x,
        clientY: 40,
      }),
    );
  pointer(source, "pointerdown", 5);
  pointer(window, "pointermove", 40);
  pointer(window, "pointerup", 40);
  await waitFor(() => expect(changed).toHaveBeenCalled());
  expect(invoke).toHaveBeenCalledWith("servers_move", {
    id: "3",
    group: "外网/公司",
  });
  Reflect.deleteProperty(document, "elementFromPoint");
});

const servers: ServerEntry[] = [
  {
    id: "1",
    name: "正式服务",
    host: "one.example",
    port: 22,
    username: "u",
    authMethod: "password",
    group: "外网/公司/业务",
  },
  {
    id: "2",
    name: "测试服务",
    host: "two.example",
    port: 22,
    username: "u",
    authMethod: "password",
    group: "外网/公司",
  },
  {
    id: "3",
    name: "本地服务",
    host: "local.example",
    port: 22,
    username: "u",
    authMethod: "password",
  },
];
const props = () => ({
  servers,
  onAdd: vi.fn(),
  onConnect: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onOpenSettings: vi.fn(),
});

it("nests folders, counts descendants and persists folding without hiding ungrouped connections", () => {
  const options = props();
  const { unmount } = render(<Sidebar {...options} />);
  const outer = screen.getByRole("button", { name: /外网.*2/ });
  expect(outer.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: /业务.*1/ })).toBeTruthy();
  fireEvent.click(outer);
  expect(screen.queryByText("正式服务")).toBeNull();
  expect(screen.getByText("本地服务")).toBeTruthy();
  unmount();
  render(<Sidebar {...options} />);
  expect(
    screen
      .getByRole("button", { name: /外网.*2/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
});

it("searches across collapsed folders and restores folding after search", () => {
  render(<Sidebar {...props()} />);
  fireEvent.click(screen.getByRole("button", { name: /外网.*2/ }));
  const search = screen.getByPlaceholderText("搜索名称 / 地址 / 分组…");
  fireEvent.change(search, { target: { value: "正式" } });
  expect(screen.getByText("正式服务")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: /外网.*1/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  expect(screen.queryByText("测试服务")).toBeNull();
  fireEvent.change(search, { target: { value: "" } });
  expect(screen.queryByText("正式服务")).toBeNull();
});

it("prefills the exact nested group for new connections and connects by keyboard", () => {
  const options = props();
  render(<Sidebar {...options} />);
  fireEvent.click(screen.getByTitle("在「外网/公司/业务」中新建连接"));
  expect(options.onAdd).toHaveBeenCalledWith("外网/公司/业务");
  fireEvent.keyDown(screen.getByLabelText("正式服务，u@one.example:22"), {
    key: "Enter",
  });
  expect(options.onConnect).toHaveBeenCalledWith(servers[0]);
});

it("clones a connection through the backend without exposing credentials", async () => {
  const changed=vi.fn(); const result=[...servers,{...servers[0],id:"clone",name:"正式服务 副本"}];
  vi.mocked(invoke).mockResolvedValueOnce(result);
  render(<Sidebar {...props()} onServersChanged={changed}/>);
  fireEvent.contextMenu(screen.getByLabelText("正式服务，u@one.example:22"));
  fireEvent.click(screen.getByRole("menuitem",{name:"克隆"}));
  await waitFor(()=>expect(changed).toHaveBeenCalledWith(result));
  expect(invoke).toHaveBeenCalledWith("servers_clone",{id:"1"});
});
