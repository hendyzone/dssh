import { act, fireEvent, render, screen } from "@testing-library/react";
import { restoreSyncUi } from "../src/lib/syncUi";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import TaskLookupSettings from "../src/components/TaskLookupSettings";
import { clearBoardCache, loadLookupSettings, saveLookupSettings } from "../src/lib/taskLookup";

const pane = { id: "p1", server: { id: "srv", name: "协同机1" }, tmux: { id: "$3", created: 1, name: "lead" } } as any;

beforeEach(() => { clearBoardCache(); mocks.invoke.mockReset(); mocks.invoke.mockImplementation(fakeInvoke()); });

it("immediately displays task lookup settings restored by sync", () => {
  render(<TaskLookupSettings/>);
  act(() => restoreSyncUi({"dssh.task-lookup.v1":JSON.stringify({
    boardUrl:"https://restored.test", terminalLinks:false, lockedProject:"demo", overrides:{}
  })}));
  expect((screen.getByLabelText("本机可访问的看板地址") as HTMLInputElement).value).toBe("https://restored.test");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
});

it("saves and tests only the direct board URL and terminal recognition switch", async () => {
  render(<TaskLookupSettings/>);
  const url=screen.getByLabelText("本机可访问的看板地址");
  fireEvent.change(url,{target:{value:"http://u:p@board"}});
  expect((screen.getByRole("button",{name:"测试连接"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(url,{target:{value:"http://board.test:8091"}});
  fireEvent.click(screen.getByRole("button",{name:"测试连接"}));
  expect(await screen.findByText("连接成功：3 个项目。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"保存地址"}));expect(loadLookupSettings().boardUrl).toBe("http://board.test:8091");
  fireEvent.click(screen.getByRole("checkbox"));expect(loadLookupSettings().terminalLinks).toBe(false);
  expect(screen.queryByLabelText("为会话指定项目")).toBeNull();expect(screen.queryByRole("button",{name:"保存指定"})).toBeNull();
});
