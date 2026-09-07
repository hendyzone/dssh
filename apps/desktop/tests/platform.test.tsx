import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "../src/platform/core";
import { listen } from "../src/platform/event";
import { getCurrentWindow } from "../src/platform/window";

afterEach(() => { delete window.dssh; });

it("reports a missing desktop runtime instead of silently accepting commands", async () => {
  await expect(invoke("servers_list")).rejects.toThrow("Electron");
});

it("installs event handlers before callers can start output and cleans them up", async () => {
  const off = vi.fn();
  let deliver!: (payload: unknown) => void;
  window.dssh = { invoke: vi.fn(), filePath: vi.fn(), listen: vi.fn((_name, fn) => { deliver = fn; return off; }) };
  const handler = vi.fn();
  const registration = listen<string>("ssh://test/data", handler);
  deliver("即时输出");
  expect(handler).toHaveBeenCalledWith({event:"ssh://test/data",payload:"即时输出"});
  (await registration)();
  expect(off).toHaveBeenCalledOnce();
});

it("removes the close handler if enabling the native guard fails", async () => {
  const off = vi.fn();
  window.dssh = { invoke: vi.fn().mockRejectedValue(new Error("closed")), listen: () => off, filePath: vi.fn() };
  await expect(getCurrentWindow().onCloseRequested(vi.fn())).rejects.toThrow("closed");
  expect(off).toHaveBeenCalledOnce();
});

it("translates native file drops to physical coordinates and removes DOM listeners", async () => {
  window.dssh = { invoke: vi.fn(), listen: vi.fn(), filePath: () => "C:\\tmp\\upload.txt" };
  const handler = vi.fn();
  const off = await listen("desktop://drag-drop", handler);
  const drop = new MouseEvent("drop", {clientX:23,clientY:42,cancelable:true});
  Object.defineProperty(drop, "dataTransfer", { value: { files:[new File(["test"], "upload.txt")] } });
  window.dispatchEvent(drop);
  expect(drop.defaultPrevented).toBe(true);
  expect(handler).toHaveBeenCalledWith({event:"desktop://drag-drop",payload:{paths:["C:\\tmp\\upload.txt"],position:{x:23*devicePixelRatio,y:42*devicePixelRatio}}});
  off(); window.dispatchEvent(drop);
  expect(handler).toHaveBeenCalledOnce();
});
