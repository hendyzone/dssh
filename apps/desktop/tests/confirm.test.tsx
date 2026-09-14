import { afterEach, expect, test, vi } from "vitest";
import { confirmAction } from "../src/lib/confirm";

const mocks = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("desktop confirmation waits for cancellation without calling the injected shim", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  const shim = vi.spyOn(window, "confirm").mockReturnValue(true);
  let resolve!: (value: boolean) => void;
  mocks.confirm.mockReturnValueOnce(new Promise<boolean>((done) => { resolve = done; }));
  const result = confirmAction("关闭连接？");
  let settled = false;
  void result.then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  resolve(false);
  expect(await result).toBe(false);
  expect(shim).not.toHaveBeenCalled();
});

test("a failed native dialog cannot approve an action", async () => {
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  mocks.confirm.mockRejectedValueOnce(new Error("dialog failed"));
  await expect(confirmAction("删除文件？")).rejects.toThrow("dialog failed");
});
