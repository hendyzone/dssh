import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import TaskLookupSettings from "../src/components/TaskLookupSettings";
import { clearBoardCache, loadLookupSettings, saveLookupSettings } from "../src/lib/taskLookup";

const pane = { id: "p1", server: { id: "srv", name: "协同机1" }, tmux: { id: "$3", created: 1, name: "lead" } } as any;

beforeEach(() => { clearBoardCache(); mocks.invoke.mockReset(); mocks.invoke.mockImplementation(fakeInvoke()); });

it("saves and tests the board URL, toggles terminal recognition and assigns projects", async () => {
  saveLookupSettings({ lockedProject: "amail" });
  render(<TaskLookupSettings sessions={[{ pane, backendId: "b" }]}/>);
  const url = screen.getByLabelText("本机可访问的看板地址");
  fireEvent.change(url, { target: { value: "http://u:p@board" } });
  expect(screen.getByRole("alert").textContent).toContain("HTTP(S)");
  fireEvent.change(url, { target: { value: "http://board.test:8091" } });
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(await screen.findByText("连接成功：3 个项目。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存地址" }));
  expect(loadLookupSettings().boardUrl).toBe("http://board.test:8091");

  const toggle = screen.getByRole("checkbox") as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  expect(loadLookupSettings().terminalLinks).toBe(false);

  expect(screen.getByText("amail")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "解锁" }));
  expect(loadLookupSettings().lockedProject).toBe("");

  fireEvent.change(screen.getByLabelText("项目编号"), { target: { value: "smart-table" } });
  fireEvent.click(screen.getByRole("button", { name: "保存指定" }));
  expect(loadLookupSettings().overrides).toEqual({ "tmux:srv:lead": "smart-table" });
  expect(screen.getAllByText(/协同机1 · tmux lead →/)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "移除" }));
  expect(loadLookupSettings().overrides).toEqual({});
});
