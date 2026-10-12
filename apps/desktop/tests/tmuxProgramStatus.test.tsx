import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { disconnectTmuxProgramStatus, removeTmuxProgramStatus, syncTmuxProgramStatus } from "../src/lib/taskStatus";
import { parseTmuxProgramSnapshot, useTmuxProgramStatus, type TmuxProgramPane } from "../src/lib/tmuxProgramStatus";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/taskStatus", () => ({
  disconnectTmuxProgramStatus: vi.fn(), removeTmuxProgramStatus: vi.fn(), syncTmuxProgramStatus: vi.fn(),
}));

const host = { serverId: "dev", name: "Dev", sessionId: "ssh-dev" };
const pane: TmuxProgramPane = {
  sessionId: "$2", sessionCreated: 123, sessionName: "agents", paneId: "%4", windowId: "@1",
  windowActive: true, paneActive: true, state: "working", app: "codex", progress: 40,
};
const response = (panes: TmuxProgramPane[] = [pane]) => ({ supported: true, panes });
const flush = () => act(async () => {});
const refresh = () => act(async () => { window.dispatchEvent(new Event("dssh-tmux-ps-refresh")); });

beforeEach(() => { vi.mocked(invoke).mockReset().mockResolvedValue(response()); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("preserves active panes without status and normalizes optional null fields", () => {
  const noState = { ...pane, paneId: "%5", paneActive: true, state: null, app: null, kind: null, progress: null, title: null, msg: null };
  expect(parseTmuxProgramSnapshot({ supported: true, panes: [{ ...pane, paneActive: false }, noState] })).toEqual({
    supported: true, panes: [{ ...pane, paneActive: false }, {
      sessionId: "$2", sessionCreated: 123, sessionName: "agents", paneId: "%5", windowId: "@1",
      windowActive: true, paneActive: true, state: null,
    }],
  });
  expect(parseTmuxProgramSnapshot({ supported: false, panes: [] })).toEqual({ supported: false, panes: [] });
});

it.each([
  null, {}, [], { supported: true, panes: {} }, { supported: false, panes: [pane] },
  response([{ ...pane, sessionId: "2" }]), response([{ ...pane, paneId: "%4;kill-server" }]),
  response([{ ...pane, windowId: "1" }]), response([{ ...pane, sessionCreated: -1 }]),
  response([{ ...pane, sessionCreated: Number.MAX_SAFE_INTEGER + 1 }]),
  response([{ ...pane, state: "unknown" } as unknown as TmuxProgramPane]),
  response([{ ...pane, paneActive: "1" } as unknown as TmuxProgramPane]),
  response([{ ...pane, msg: "bad\nmessage" }]), response([{ ...pane, title: "x".repeat(193) }]),
  response([{ ...pane, progress: 101 }]), response([pane, pane]),
])("rejects a malformed snapshot atomically (%#)", (value) => {
  expect(() => parseTmuxProgramSnapshot(value)).toThrow("tmux 程序状态响应无效");
});

it("suppresses initial and recovery alerts and synchronizes changed state on later polls", async () => {
  const view = renderHook(() => useTmuxProgramStatus([host]));
  await flush();
  expect(invoke).toHaveBeenCalledWith("tmux_program_status", { sessionId: "ssh-dev" });
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("dev", "Dev", [pane], false);
  const done = { ...pane, state: "done" as const, progress: undefined };
  vi.mocked(invoke).mockResolvedValue(response([done]));
  await refresh();
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("dev", "Dev", [done], true);
  vi.mocked(invoke).mockRejectedValue(new Error("connection lost"));
  await refresh();
  expect(disconnectTmuxProgramStatus).toHaveBeenLastCalledWith("dev");
  expect(view.result.current.dev.error).toContain("connection lost");
  expect(view.result.current.dev.panes).toEqual([done]);
  vi.mocked(invoke).mockResolvedValue(response([done]));
  await refresh();
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("dev", "Dev", [done], false);
  expect(view.result.current.dev.error).toBe("");
  view.unmount();
  expect(removeTmuxProgramStatus).toHaveBeenLastCalledWith("dev");
});

it("does not apply a partial malformed snapshot or discard the last known view", async () => {
  const view = renderHook(() => useTmuxProgramStatus([host]));
  await flush();
  const previous = view.result.current.dev.panes;
  vi.mocked(invoke).mockResolvedValue(response([{ ...pane, state: "done" }, { ...pane, paneId: "invalid" }]));
  await refresh();
  expect(syncTmuxProgramStatus).toHaveBeenCalledTimes(1);
  expect(disconnectTmuxProgramStatus).toHaveBeenCalledWith("dev");
  expect(view.result.current.dev.panes).toBe(previous);
  expect(view.result.current.dev.error).toContain("响应无效");
});

it("keeps old tmux versions quiet and treats newly available native support as an initial snapshot", async () => {
  vi.mocked(invoke).mockResolvedValue({ supported: false, panes: [] });
  const view = renderHook(() => useTmuxProgramStatus([host]));
  await flush();
  expect(view.result.current.dev).toEqual({ supported: false, panes: [], error: "" });
  expect(disconnectTmuxProgramStatus).not.toHaveBeenCalled();
  vi.mocked(invoke).mockResolvedValue(response());
  await refresh();
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("dev", "Dev", [pane], false);
});

it("polls every 2500ms without overlapping requests for a server", async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  renderHook(() => useTmuxProgramStatus([host]));
  await act(async () => { vi.advanceTimersByTime(10000); });
  await refresh();
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(response()); });
  await act(async () => { vi.advanceTimersByTime(2499); });
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("dev", "Dev", [pane], true);
});

it("discards stale connection results and removes statuses when a host disappears", async () => {
  let resolveOld!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolveOld = done; }));
  const view = renderHook(({ hosts }) => useTmuxProgramStatus(hosts), { initialProps: { hosts: [host] } });
  const next = { ...host, sessionId: "new-ssh" };
  view.rerender({ hosts: [next] });
  await flush();
  expect(disconnectTmuxProgramStatus).toHaveBeenCalledWith("dev");
  expect(removeTmuxProgramStatus).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith("tmux_program_status", { sessionId: "new-ssh" });
  expect(syncTmuxProgramStatus).toHaveBeenCalledTimes(1);
  await act(async () => { resolveOld(response([{ ...pane, state: "error" }])); });
  expect(syncTmuxProgramStatus).toHaveBeenCalledTimes(1);
  expect(view.result.current.dev.panes[0].state).toBe("working");
  view.rerender({ hosts: [] });
  await flush();
  expect(view.result.current).toEqual({});
  expect(removeTmuxProgramStatus).toHaveBeenCalledTimes(1);
});

it("does not restart unaffected hosts when another connection is added or removed", async () => {
  const other = { serverId: "prod", name: "Prod", sessionId: "ssh-prod" };
  const view = renderHook(({ hosts }) => useTmuxProgramStatus(hosts), { initialProps: { hosts: [host] } });
  await flush();
  view.rerender({ hosts: [host, other] });
  await flush();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("prod", "Prod", [pane], false);
  view.rerender({ hosts: [host] });
  await flush();
  expect(removeTmuxProgramStatus).toHaveBeenCalledWith("prod");
  expect(view.result.current.prod).toBeUndefined();
  await refresh();
  expect(syncTmuxProgramStatus).toHaveBeenLastCalledWith("dev", "Dev", [pane], true);
});

it("refreshes on focus and becoming visible so pane activity can be re-evaluated", async () => {
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const view = renderHook(() => useTmuxProgramStatus([host]));
  await flush();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(invoke).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(true);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(invoke).toHaveBeenCalledTimes(2);
  hidden.mockReturnValue(false);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(invoke).toHaveBeenCalledTimes(3);
  view.unmount();
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(invoke).toHaveBeenCalledTimes(3);
});
