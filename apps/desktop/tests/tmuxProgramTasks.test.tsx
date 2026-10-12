import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { acknowledgeTasks, disconnectTmuxProgramStatus, enableDesktopNotifications, focusTask, focusTmuxPane,
  removeTask, removeTmuxProgramStatus, reportTask, syncTmuxProgramStatus, taskSnapshot, tmuxProgramTaskId } from "../src/lib/taskStatus";
import type { TmuxProgramPane } from "../src/lib/tmuxProgramStatus";

vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(), isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(async () => "granted"),
}));
const pane: TmuxProgramPane = { sessionId: "$7", sessionCreated: 123, sessionName: "build", paneId: "%9",
  windowId: "@2", windowActive: true, paneActive: true, state: "working", app: "codex" };
const target = { serverId: "host", sessionId: "$7", sessionCreated: 123, sessionName: "build", paneId: "%9" };
const sync = (panes: TmuxProgramPane[], notify = true) => syncTmuxProgramStatus("host", "Server", panes, notify);
const record = () => taskSnapshot().find(task => task.id === tmuxProgramTaskId(target))!;
beforeEach(() => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  focusTmuxPane("other");
});
afterEach(() => {
  removeTmuxProgramStatus("host"); removeTmuxProgramStatus("other-host");
  taskSnapshot().forEach(task => removeTask(task.id));
  focusTmuxPane(""); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("keeps each server, session incarnation and hidden pane separate, with replacement and removal", () => {
  sync([pane, { ...pane, paneId: "%10", windowActive: false, state: "blocked", kind: "auth", progress: 40 }]);
  syncTmuxProgramStatus("other-host", "Other", [pane], false);
  expect(taskSnapshot()).toHaveLength(3);
  expect(taskSnapshot().find(task => task.tmux?.paneId === "%10")).toMatchObject({
    phase: "waiting", unread: true, kind: "auth", progress: 40, protocolScope: "tmux-pane",
  });
  sync([{ ...pane, state: "done", app: undefined }]);
  expect(taskSnapshot()).toHaveLength(2);
  expect(record()).toMatchObject({ phase: "done", unread: true, recordId: "" });
  expect(record().app).toBeUndefined();
  sync([{ ...pane, sessionCreated: 124 }]);
  expect(record()).toBeUndefined();
  expect(taskSnapshot().find(task => task.tmux?.serverId === "host")?.tmux?.sessionCreated).toBe(124);
  sync([{ ...pane, sessionCreated: 124, state: null }]);
  expect(taskSnapshot()).toHaveLength(1);
});

it("does not replay initial or recovered results, but a new cycle becomes unread", () => {
  sync([{ ...pane, state: "done" }], false);
  expect(record().unread).toBe(false);
  sync([{ ...pane, state: "done" }]);
  expect(record().unread).toBe(false);
  sync([pane]); sync([{ ...pane, state: "done" }]);
  expect(record().unread).toBe(true);
  acknowledgeTasks();
  disconnectTmuxProgramStatus("host");
  expect(record().phase).toBe("disconnected");
  sync([{ ...pane, state: "done" }], false);
  expect(record()).toMatchObject({ phase: "done", unread: false });
});

it("acknowledges only the precise visible pane and clears focus when a no-status pane becomes active", () => {
  sync([{ ...pane, state: "done" }, { ...pane, paneId: "%10", state: "done" }]);
  focusTmuxPane("client", target);
  expect(record().unread).toBe(false);
  expect(taskSnapshot().find(task => task.tmux?.paneId === "%10")?.unread).toBe(true);
  focusTask("client"); // Keystrokes in the same terminal keep the verified pane identity.
  sync([pane, { ...pane, paneId: "%10", state: "done" }]);
  sync([{ ...pane, state: "done" }, { ...pane, paneId: "%10", state: "done" }]);
  expect(record().unread).toBe(false);
  focusTmuxPane("client", { ...target, paneId: "%11" });
  const empty = { ...pane, paneId: "%11", state: null };
  sync([{ ...pane, paneActive: false }, empty]); sync([{ ...pane, paneActive: false, state: "done" }, empty]);
  expect(record().unread).toBe(true);
});

it("prefers the same app's native pane status, retains unrelated Hooks and resumes after clear or failure", () => {
  const meta = { provider: "codex" as const, sourcePaneId: "client", tmux: target };
  reportTask("hook", "Codex", "working", "hook", false, false, 1, meta);
  reportTask("other-pane-hook", "Codex", "working", "hook", false, false, 1, { ...meta, tmux: { ...target, paneId: "%10" } });
  sync([{ ...pane, state: "blocked" }]);
  reportTask("hook", "Codex", "idle", "delayed", false, true, 2, meta);
  expect(taskSnapshot().some(task => task.id === "hook")).toBe(false);
  expect(taskSnapshot().some(task => task.id === "other-pane-hook")).toBe(true);
  sync([{ ...pane, state: "blocked", app: undefined }]);
  reportTask("hook", "Codex", "working", "new event", false, true, 3, meta);
  expect(taskSnapshot().some(task => task.id === "hook")).toBe(true);
  sync([{ ...pane, state: "blocked" }]);
  disconnectTmuxProgramStatus("host");
  reportTask("hook", "Codex", "waiting", "fallback", false, true, 4, meta);
  expect(taskSnapshot().some(task => task.id === "hook")).toBe(true);
  sync([]);
  reportTask("hook", "Codex", "working", "after clear", false, true, 5, meta);
  expect(taskSnapshot().find(task => task.id === "hook")?.phase).toBe("working");
});

it("rate limits each pane without treating progress or identical polling as a new event", async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000); vi.stubGlobal("__TAURI_INTERNALS__", {});
  await enableDesktopNotifications();
  sync([{ ...pane, state: "blocked", kind: "permission", progress: 20 }]);
  expect(sendNotification).toHaveBeenCalledTimes(1);
  acknowledgeTasks();
  sync([{ ...pane, state: "blocked", kind: "permission", progress: 50 }]);
  expect(record().unread).toBe(false);
  expect(record().progress).toBe(50);
  expect(sendNotification).toHaveBeenCalledTimes(1);
  sync([{ ...pane, state: "done" }]);
  expect(record().unread).toBe(true);
  expect(sendNotification).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(5000);
  sync([pane]); sync([{ ...pane, state: "error" }]);
  expect(sendNotification).toHaveBeenCalledTimes(2);
  expect(sendNotification).toHaveBeenLastCalledWith(expect.objectContaining({ extra: { taskId: tmuxProgramTaskId(target) } }));
});

it.each(["idle", "done", "error"] as const)("allows the next Hooks lifecycle alongside a retained native %s", state => {
  sync([{ ...pane, state }]);
  reportTask("new-hook", "Codex", "working", "next run", false, true, 1,
    { provider: "codex", tmux: target });
  sync([{ ...pane, state }]);
  expect(record().programState).toBe(state);
  expect(taskSnapshot().find(task => task.id === "new-hook")?.phase).toBe("working");
  sync([{ ...pane, state: "working" }]);
  expect(taskSnapshot().find(task => task.id === "new-hook")).toBeUndefined();
});

it("uses the new snapshot's focus before evaluating the previous pane's completion", () => {
  sync([pane]);
  focusTmuxPane("client", target);
  sync([{ ...pane, paneActive: false, state: "done" }, { ...pane, paneId: "%10", state: "done" }]);
  expect(record().unread).toBe(true);
  expect(taskSnapshot().find(task => task.tmux?.paneId === "%10")?.unread).toBe(false);
});
