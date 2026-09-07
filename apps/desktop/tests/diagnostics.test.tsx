import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { installDiagnostics } from "../src/lib/diagnostics";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));

it("records runtime errors and rejected promises and removes listeners on cleanup", () => {
  const dispose = installDiagnostics();
  const error = new Error("runtime failure");
  window.dispatchEvent(new ErrorEvent("error", {message:error.message, error}));
  expect(invoke).toHaveBeenCalledWith("desktop_report_error", {message:error.message, stack:error.stack});
  const event = new Event("unhandledrejection");
  Object.defineProperty(event, "reason", {value:new Error("async failure")});
  window.dispatchEvent(event);
  expect(invoke).toHaveBeenCalledWith("desktop_report_error", expect.objectContaining({message:"Unhandled promise rejection: async failure"}));
  dispose();
  vi.mocked(invoke).mockClear();
  window.dispatchEvent(new ErrorEvent("error", {message:"after cleanup"}));
  expect(invoke).not.toHaveBeenCalled();
});
