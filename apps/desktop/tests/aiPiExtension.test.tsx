import { expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import extension from "../src-tauri/src/ai_pi_extension";
vi.mock("node:child_process", () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

it("emits only lifecycle metadata for pi and never modifies permission decisions", async () => {
  vi.stubGlobal("__DSSH_PYTHON__", "/usr/bin/python3");
  vi.stubGlobal("__DSSH_HELPER__", "/home/test/ai_status.py");
  vi.mocked(execFile).mockImplementation(((...args: any[]) => { args[3](new Error("bridge unavailable")); }) as any);
  const handlers = new Map<string, Function>();
  extension({ on: (name: string, fn: Function) => handlers.set(name, fn) });
  const ctx = { sessionManager: { getSessionId: () => "session-one" }, isIdle: () => false };
  await expect(handlers.get("ui_prompt_start")!({ title: "secret prompt" }, ctx)).resolves.toBeUndefined();
  expect(execFile).toHaveBeenCalledWith("/usr/bin/python3", ["/home/test/ai_status.py", "event", "pi",
    JSON.stringify({ hook_event_name: "ui_prompt_start", session_id: "session-one" })], expect.objectContaining({ timeout: 1500 }), expect.any(Function));
  await handlers.get("agent_end")!({ messages: [{ role: "assistant", stopReason: "error", content: "secret answer" }] }, ctx);
  expect(vi.mocked(execFile).mock.calls.at(-1)?.[1]).toContain(JSON.stringify({ hook_event_name: "error", session_id: "session-one" }));
  expect(JSON.stringify(vi.mocked(execFile).mock.calls)).not.toContain("secret");
  vi.unstubAllGlobals();
});
