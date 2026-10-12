import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TasksPanel from "../src/components/TasksPanel";
import { subscribeTasks, taskSnapshot, type TaskStatus } from "../src/lib/taskStatus";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/taskStatus", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/taskStatus")>(),
  taskSnapshot: vi.fn(),
  subscribeTasks: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(taskSnapshot).mockReturnValue([]);
  vi.mocked(subscribeTasks).mockReturnValue(() => {});
});

const programTask = (changes: Partial<TaskStatus> = {}): TaskStatus => ({
  id: "osc:ssh:deploy/eu-west",
  name: "Dev · tmux %2",
  sourcePaneId: "ssh",
  protocol: "osc7501",
  programState: "working",
  recordId: "deploy/eu-west",
  app: "terraform",
  title: "欧洲部署",
  phase: "working",
  message: "正在部署",
  updated: Date.now() - 60000,
  estimated: false,
  unread: false,
  ...changes,
});

it("only configures the selected provider on an explicit action and exposes uninstall", async () => {
  vi.mocked(invoke).mockResolvedValue({ message: "已接入，请重启工具" });
  render(<TasksPanel sessionId="ssh" serverName="Dev" onClose={() => {}} onSelect={() => {}} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("接入 AI 状态 · Dev"));
  fireEvent.change(screen.getByLabelText("AI 工具"), { target: { value: "codex" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "接入", exact: true })));
  expect(invoke).toHaveBeenCalledWith("ai_setup", { sessionId: "ssh", provider: "codex", remove: false });
  expect(screen.getByRole("status").textContent).toContain("请重启工具");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "移除接入" })));
  expect(invoke).toHaveBeenLastCalledWith("ai_setup", { sessionId: "ssh", provider: "codex", remove: true });
});

it("shows the source, program, child record and explicit progress and opens the exact task", () => {
  const task = programTask({ progress: 0 });
  vi.mocked(taskSnapshot).mockReturnValue([task]);
  const onSelect = vi.fn();
  render(<TasksPanel onClose={() => {}} onSelect={onSelect} />);
  const card = screen.getByRole("button", { name: /Dev · tmux %2/ });
  expect(within(card).getByText("terraform · 程序上报")).toBeTruthy();
  expect(within(card).getByText("欧洲部署")).toBeTruthy();
  expect(within(card).getByText("deploy/eu-west")).toBeTruthy();
  expect(within(card).getByText("处理中")).toBeTruthy();
  expect(screen.queryByText("暂时无输出")).toBeNull();
  expect(screen.getByRole("progressbar", { name: "欧洲部署进度" }).getAttribute("value")).toBe("0");
  expect(within(card).getByText("0%")).toBeTruthy();
  fireEvent.click(card);
  expect(onSelect).toHaveBeenCalledWith(task.id);
});

it.each([
  ["permission", "等待批准"],
  ["question", "等待回答"],
  ["auth", "等待登录"],
] as const)("shows the %s blocked reason and renders the program message as plain text", (kind, label) => {
  const message = '<img src=x onerror="alert(1)"> [允许](https://example.com)';
  vi.mocked(taskSnapshot).mockReturnValue([programTask({
    programState: "blocked", phase: "waiting", kind, message, progress: 40, unread: true,
  })]);
  const { container } = render(<TasksPanel onClose={() => {}} onSelect={() => {}} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText(message)).toBeTruthy();
  expect(container.querySelector("img, a")).toBeNull();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("40");
});

it("keeps working without a percentage when the program did not report progress", () => {
  vi.mocked(taskSnapshot).mockReturnValue([programTask()]);
  render(<TasksPanel onClose={() => {}} onSelect={() => {}} />);
  expect(screen.getByText("处理中")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("暂时无输出")).toBeNull();
});

it("identifies tmux passthrough as a source tab without claiming an internal pane", () => {
  const task = programTask({ name: "Dev · build", protocolScope: "tmux-client" });
  vi.mocked(taskSnapshot).mockReturnValue([task]);
  const onSelect = vi.fn();
  render(<TasksPanel onClose={() => {}} onSelect={onSelect} />);
  expect(screen.getByText("tmux 透传 · 来源为此标签").title).toContain("不包含远端 tmux 窗格标识");
  fireEvent.click(screen.getByRole("button", { name: /Dev · build/ }));
  expect(onSelect).toHaveBeenCalledWith(task.id);
});

it("shows the exact tmux session and pane for a native pane report", () => {
  const task = programTask({
    protocolScope: "tmux-pane", sourcePaneId: undefined,
    tmux: { serverId: "dev", sessionId: "$4", sessionCreated: 123, sessionName: "de\u202eploy\n", paneId: "%8" },
  });
  vi.mocked(taskSnapshot).mockReturnValue([task]);
  const onSelect = vi.fn();
  render(<TasksPanel onClose={() => {}} onSelect={onSelect} />);
  expect(screen.getByText("tmux · deploy · %8")).toBeTruthy();
  expect(screen.queryByText("tmux 透传 · 来源为此标签")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /tmux · deploy · %8/ }));
  expect(onSelect).toHaveBeenCalledWith(task.id);
});

it.each(["working", "done"] as const)("shows disconnected native %s results as unavailable instead of live status", programState => {
  vi.mocked(taskSnapshot).mockReturnValue([programTask({
    protocolScope: "tmux-pane", phase: "disconnected", programState, progress: 40, unread: true,
    tmux: { serverId: "dev", sessionId: "$4", sessionCreated: 123, sessionName: "deploy", paneId: "%8" },
  })]);
  render(<TasksPanel onClose={() => {}} onSelect={() => {}} />);
  expect(screen.getByText("连接断开")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByText("已完成 · 待查看")).toBeNull();
  expect(screen.getByText("tmux · deploy · %8")).toBeTruthy();
});

it("distinguishes an unread completed result from a viewed result without hiding it", () => {
  const task = programTask({ programState: "done", phase: "done", unread: true });
  vi.mocked(taskSnapshot).mockReturnValue([task]);
  render(<TasksPanel onClose={() => {}} onSelect={() => {}} />);
  expect(screen.getByText("已完成 · 待查看")).toBeTruthy();
  vi.mocked(taskSnapshot).mockReturnValue([{ ...task, unread: false }]);
  act(() => vi.mocked(subscribeTasks).mock.calls[0][0]());
  expect(screen.getByText("已完成 · 已查看")).toBeTruthy();
  expect(screen.queryByText("已完成 · 待查看")).toBeNull();
  expect(screen.getByText("欧洲部署")).toBeTruthy();
});

it("retains Hooks event labels and estimated terminal status alongside program reports", () => {
  vi.mocked(taskSnapshot).mockReturnValue([
    programTask(),
    { id: "hook", name: "Claude pane", provider: "claude", phase: "waiting", message: "PermissionRequest", estimated: false, unread: true, updated: Date.now() },
    { id: "legacy", name: "Other pane", phase: "running", message: "根据终端输出判断", estimated: true, unread: false, updated: Date.now() - 60000 },
  ]);
  render(<TasksPanel onClose={() => {}} onSelect={() => {}} />);
  expect(screen.getByText("Claude · 工具事件")).toBeTruthy();
  expect(screen.getByText("需要关注")).toBeTruthy();
  expect(screen.getByText("暂时无输出 · 推测")).toBeTruthy();
  expect(screen.getByText("处理中")).toBeTruthy();
});
