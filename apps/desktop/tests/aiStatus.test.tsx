import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { reportTask, removeTask } from "../src/lib/taskStatus";
import { useAiStatus, parseAiTasks, type AiTask } from "../src/lib/aiStatus";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/taskStatus", () => ({ reportTask: vi.fn(), removeTask: vi.fn() }));
const task: AiTask = { id: "a".repeat(64), provider: "codex", phase: "working", updated: 100, revision: "1", paneId: "pane", connectionId: "ssh" };
const host = { serverId: "host", name: "Server", sessionId: "ssh" };
const refresh = () => act(() => window.dispatchEvent(new Event("dssh-ai-refresh")));

it("notifies transitions once, suppresses initial/reconnect replay and removes vanished tasks", async () => {
  vi.mocked(invoke).mockResolvedValue([task]);
  const view = renderHook(() => useAiStatus([host]));
  await waitFor(() => expect(reportTask).toHaveBeenCalledWith(`ai:host:${task.id}`, "Server · Codex", "working", "处理中", false, false, 100, { provider: "codex", sourcePaneId: "pane" }));
  vi.mocked(invoke).mockResolvedValue([{ ...task, phase: "waiting", updated: 200, revision: "2" }]);
  refresh();
  await waitFor(() => expect(reportTask).toHaveBeenLastCalledWith(`ai:host:${task.id}`, "Server · Codex", "waiting", "需要确认或输入", false, true, 200, expect.any(Object)));
  const count = vi.mocked(reportTask).mock.calls.length;
  refresh();
  await act(async () => {});
  expect(reportTask).toHaveBeenCalledTimes(count);
  vi.mocked(invoke).mockRejectedValue(new Error("network down"));
  refresh();
  await waitFor(() => expect(view.result.current.host.error).toContain("状态未知"));
  vi.mocked(invoke).mockResolvedValue([{ ...task, phase: "idle", updated: 300, revision: "3" }]);
  refresh();
  await waitFor(() => expect(reportTask).toHaveBeenLastCalledWith(`ai:host:${task.id}`, "Server · Codex", "idle", "本轮已结束", false, false, 300, expect.any(Object)));
  vi.mocked(invoke).mockResolvedValue([]);
  refresh();
  await waitFor(() => expect(removeTask).toHaveBeenCalledWith(`ai:host:${task.id}`));
  view.unmount();
});

it("ignores closed direct panes and binds live tmux activity to the correct client pane", async () => {
  const tmux = { id: "$2", created: 123, name: "work", pane: "%5" };
  vi.mocked(invoke).mockResolvedValue([task, { ...task, id: "b".repeat(64), paneId: undefined, tmux, active: true }]);
  const view = renderHook(() => useAiStatus([host], [{ id: "attached", server: { id: "host" } as any, tmux }]));
  await waitFor(() => expect(view.result.current.host.tasks).toHaveLength(1));
  expect(reportTask).toHaveBeenCalledWith(expect.any(String), expect.any(String), "working", "处理中", false, false, 100,
    { provider: "codex", sourcePaneId: "attached" });
});

it("rejects malformed or unknown remote identities", () => {
  expect(parseAiTasks([{ ...task, provider: "other" }, { ...task, paneId: undefined }, { ...task, tmux: { id: "$2", created: "123", pane: "%1" } }])).toEqual([]);
  expect(() => parseAiTasks({})).toThrow();
});
it("does not restore a dead process status into a new SSH incarnation of the same pane", async () => {
  vi.mocked(invoke).mockResolvedValue([task]);
  const view = renderHook(() => useAiStatus([host], [{ id: "pane", server: { id: "host" } as any }], { pane: "new-ssh" }));
  await waitFor(() => expect(view.result.current.host).toBeTruthy());
  expect(view.result.current.host.tasks).toEqual([]);
  expect(reportTask).not.toHaveBeenCalled();
});
