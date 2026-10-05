import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import type { Transfer } from "../src/lib/transfers";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); vi.mocked(listen).mockClear(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
async function setup() {
  const api = await import("../src/lib/transfers");
  let current: Transfer[] = [];
  const unsubscribe = api.subscribeTransfers("session", (items) => { current = items; });
  const id = api.createTransfer("session", "卡图", "upload");
  const event = vi.mocked(listen).mock.calls[0][1] as (event: any) => void;
  const finish = (error?: string) => event({ payload: {
    transferId: id, direction: "upload", fileName: "卡图",
    transferredBytes: 0, totalBytes: 0, done: true, error,
  }});
  return { ...api, id, finish, unsubscribe, current: () => current };
}
it("expires failed transfers after ten seconds even with the panel closed", async () => {
  const api = await setup();
  api.finish("拒绝访问");
  expect(api.current()[0].status).toBe("error");
  vi.advanceTimersByTime(9999);
  expect(api.current()).toHaveLength(1);
  api.unsubscribe();
  vi.advanceTimersByTime(1);
  let reopened: Transfer[] = [];
  api.subscribeTransfers("session", (items) => { reopened = items; });
  expect(reopened).toEqual([]);
});
it("manual dismissal persists when subscribing again, but cannot dismiss active work", async () => {
  const api = await setup();
  api.dismissTransfer(api.id);
  vi.advanceTimersByTime(60_000);
  expect(api.current()[0].status).toBe("active");
  api.finish("失败");
  api.dismissTransfer(api.id);
  expect(api.current()).toEqual([]);
  let reopened: Transfer[] = [];
  api.subscribeTransfers("session", (items) => { reopened = items; });
  expect(reopened).toEqual([]);
});
it("still expires successful transfers after five seconds", async () => {
  const api = await setup();
  api.finish();
  vi.advanceTimersByTime(4999);
  expect(api.current()[0].status).toBe("done");
  vi.advanceTimersByTime(1);
  expect(api.current()).toEqual([]);
});
it("keeps canceled or partially failed folder downloads until dismissed", async () => {
  const api = await setup();
  const event = vi.mocked(listen).mock.calls[0][1] as (event: any) => void;
  const tree = api.createTransfer("session", "项目", "download", "tree");
  expect(api.current().find((t) => t.transferId === tree)?.tree?.phase).toBe("scanning");
  event({ payload: { transferId: tree, direction: "download", fileName: "项目", transferredBytes: 10, totalBytes: 100, done: true,
    tree: { phase: "done", canceled: true, totalFiles: 5, completedFiles: 2, failureCount: 0, skippedCount: 0 } } });
  const canceled = api.current().find((t) => t.transferId === tree)!;
  expect(canceled.status).toBe("canceled");
  vi.advanceTimersByTime(60_000);
  expect(api.current().some((t) => t.transferId === tree)).toBe(true);
  api.dismissTransfer(tree);
  expect(api.current().some((t) => t.transferId === tree)).toBe(false);
});
