import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke, NOW } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import TaskLookup from "../src/components/TaskLookup";
import TaskCard from "../src/components/TaskCard";
import { boardSource, clearBoardCache, defaultLookupSettings, loadCard, loadLookupSettings, saveLookupSettings } from "../src/lib/taskLookup";

const source = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test:8091" })!;
const state: { opened: string[]; calls: string[]; offline?: boolean } = { opened: [], calls: [] };

beforeEach(() => {
  clearBoardCache();
  state.opened = []; state.calls = []; state.offline = false;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(fakeInvoke(state));
});

const typeAndSubmit = (value: string) => {
  fireEvent.change(screen.getByLabelText("任务编号"), { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: /查询/ }));
};

it("locks a project, persists it, and then locates a task by number only", async () => {
  render(<TaskLookup source={source}/>);
  const select = await screen.findByLabelText("查询项目");
  await screen.findByRole("option", { name: "智能台球桌 · smart-table" });
  fireEvent.change(select, { target: { value: "smart-table" } });
  fireEvent.click(screen.getByRole("button", { name: /锁定/ }));
  expect(loadLookupSettings().lockedProject).toBe("smart-table");
  expect(await screen.findByText("智能台球桌")).toBeTruthy();
  expect(screen.queryByLabelText("查询项目")).toBeNull();

  typeAndSubmit("t1090");
  const card = await screen.findByRole("article", { name: "任务 T1090" });
  expect(within(card).getByText("击球辅助线样式统一：实线改虚线并补齐全部入口")).toBeTruthy();
  expect(within(card).getByText("待人工验收")).toBeTruthy();
  expect(within(card).getByText("cw3d-pi")).toBeTruthy();
  expect(within(card).getByText("9191 实机核对通过")).toBeTruthy();

  // Unlock returns to the selector, still on the previously locked project.
  fireEvent.click(screen.getByRole("button", { name: /解锁/ }));
  expect(loadLookupSettings().lockedProject).toBe("");
  expect((screen.getByLabelText("查询项目") as HTMLSelectElement).value).toBe("smart-table");
});

it("lists candidates for an ambiguous number and opens the chosen one", async () => {
  saveLookupSettings({ lockedProject: "smart-table" });
  render(<TaskLookup source={source}/>);
  typeAndSubmit("1090");
  const choices = await screen.findByLabelText("候选任务");
  expect(within(choices).getByText(/匹配到 2 个任务/)).toBeTruthy();
  fireEvent.click(within(choices).getByText("ST-1090"));
  expect(await screen.findByRole("article", { name: "任务 ST-1090" })).toBeTruthy();
});

it("accepts 「项目 编号」 when unlocked and shows clear errors", async () => {
  render(<TaskLookup source={source}/>);
  typeAndSubmit("amail AM-42");
  expect(await screen.findByRole("article", { name: "任务 AM-42" })).toBeTruthy();
  typeAndSubmit("nope T1");
  expect((await screen.findByRole("alert")).textContent).toContain("看板上没有项目「nope」");
  typeAndSubmit("smart-table T9999");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("项目「smart-table」中没有编号「T9999」"));
  clearBoardCache();
  state.offline = true;
  typeAndSubmit("smart-table T1090");
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("看板不可达"));
});

it("explains how to configure when no board is reachable", () => {
  render(<TaskLookup/>);
  typeAndSubmit("T1");
  expect(screen.getAllByText(/未配置看板地址/).length).toBeGreaterThan(0);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("shows the inferred project and browses tasks with filters", async () => {
  render(<TaskLookup source={source} inferred={{ project: "smart-table", reason: "collaboration" }}/>);
  expect(screen.getByText(/当前终端项目：smart-table（Agent 协作绑定）/)).toBeTruthy();
  const browser = screen.getByText(/浏览 smart-table 的任务/).closest("details")!;
  await act(async () => { browser.open = true; fireEvent(browser, new Event("toggle")); });
  await screen.findByLabelText("按状态筛选");
  fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "blocked" } });
  expect(within(browser).getAllByRole("button").filter(b => b.classList.contains("task-list-row")).map(b => b.querySelector(".tb-card-code")!.textContent)).toEqual(["T1091"]);
  fireEvent.change(screen.getByLabelText("按状态筛选"), { target: { value: "" } });
  fireEvent.change(screen.getByLabelText("按负责人筛选"), { target: { value: "cw3d-pi" } });
  fireEvent.change(screen.getByLabelText("搜索标题"), { target: { value: "辅助线" } });
  const rows = within(browser).getAllByRole("button").filter(b => b.classList.contains("task-list-row"));
  expect(rows).toHaveLength(1);
  fireEvent.click(rows[0]);
  expect(await screen.findByRole("article", { name: "任务 T1090" })).toBeTruthy();
});

it("renders blocked reason prominently, collapses detail, follows dependencies and opens the board", async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  const card = await loadCard(source, "smart-table", "T1090");
  const open = vi.fn();
  const view = render(<TaskCard card={card} source={source} onOpenCode={open} now={NOW}/>);
  expect(screen.getByText("3 小时")).toBeTruthy(); // in current column
  expect(screen.getByText("30 分钟前")).toBeTruthy(); // last update
  const detail = screen.getByText("详细记录").closest("details")!;
  expect(detail.open).toBe(false);
  const dep = screen.getByTitle("被阻塞的任务");
  expect(within(dep).getByText("已阻塞")).toBeTruthy();
  fireEvent.click(dep);
  expect(open).toHaveBeenCalledWith("smart-table", "T1091");
  fireEvent.click(screen.getByRole("button", { name: "在看板中打开" }));
  await waitFor(() => expect(state.opened).toEqual(["http://board.test:8091/?project=smart-table&task=T1090"]));
  view.unmount();

  const blocked = await loadCard(source, "smart-table", "T1091");
  render(<TaskCard card={blocked} source={source} now={NOW}/>);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("等硬件到货");
  expect(alert.className).toContain("is-active");
  vi.restoreAllMocks();
});
