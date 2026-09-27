import { afterEach, expect, it, vi } from "vitest";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { enableDesktopNotifications, focusTask, reportTask, removeTask, taskSnapshot } from "../src/lib/taskStatus";
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(), isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(async () => "granted"),
}));
afterEach(() => {
  while (taskSnapshot().length) taskSnapshot().forEach(task => removeTask(task.id));
  focusTask("");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("sends one desktop reminder for a background transition and suppresses a focused source", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  await enableDesktopNotifications();
  focusTask("pane");
  reportTask("ai", "Codex", "waiting", "需要确认", false, true, 1, { provider: "codex", sourcePaneId: "pane" });
  expect(sendNotification).not.toHaveBeenCalled();
  focusTask("other-pane");
  reportTask("ai", "Codex", "working", "处理中", false, true, 2, { provider: "codex", sourcePaneId: "pane" });
  reportTask("ai", "Codex", "idle", "本轮已结束", false, true, 3, { provider: "codex", sourcePaneId: "pane" });
  reportTask("ai", "Codex", "idle", "本轮已结束", false, true, 3, { provider: "codex", sourcePaneId: "pane" });
  expect(sendNotification).toHaveBeenCalledTimes(1);
  expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ body: "本轮已结束" }));
});
