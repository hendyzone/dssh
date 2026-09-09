import { afterEach, expect, it, vi } from "vitest";
import { createTerminalOutput } from "../src/lib/terminalOutput";

const begin = "\x1b[?2026h";
const end = "\x1b[?2026l";
afterEach(() => vi.useRealTimers());

it("passes ordinary shell output through immediately and unchanged", () => {
  const write = vi.fn();
  const output = createTerminalOutput(write);
  output.push("hello\r\n\x1b[31mred\x1b[0m");
  expect(write).toHaveBeenCalledExactlyOnceWith("hello\r\n\x1b[31mred\x1b[0m");
  output.dispose();
});

it("never presents the intermediate cleared screen at any SSH packet boundary", () => {
  const frame = begin + "\x1b[H\x1b[Jfirst\r\nsecond\x1b[2A" + end;
  for (let split = 1; split < frame.length; split++) {
    const write = vi.fn();
    const output = createTerminalOutput(write);
    output.push(frame.slice(0, split));
    expect(write).not.toHaveBeenCalled();
    output.push(frame.slice(split));
    expect(write).toHaveBeenCalledExactlyOnceWith(frame);
    output.dispose();
  }
});

it("handles byte-sized packets, consecutive updates and ordinary text in order", () => {
  const writes: string[] = [];
  const output = createTerminalOutput((data) => writes.push(data));
  const frame = begin + "中文\r\n" + end;
  output.push("prompt");
  for (const char of frame) output.push(char);
  output.push(frame + "tail" + begin + "unfinished");
  expect(writes).toEqual(["prompt", frame, frame + "tail"]);
  output.flush();
  expect(writes.join("")).toBe("prompt" + frame + frame + "tail" + begin + "unfinished");
  output.dispose();
});

it("releases unterminated output on a fixed deadline despite new packets", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const output = createTerminalOutput(write);
  output.push(begin + "first");
  vi.advanceTimersByTime(900);
  output.push("second");
  expect(write).not.toHaveBeenCalled();
  vi.advanceTimersByTime(100);
  expect(write).toHaveBeenCalledExactlyOnceWith(begin + "firstsecond");
  output.push("normal");
  expect(write).toHaveBeenLastCalledWith("normal");
  output.dispose();
});

it("preserves unrelated split escape sequences and flushes a trailing escape", () => {
  vi.useFakeTimers();
  const writes: string[] = [];
  const output = createTerminalOutput((data) => writes.push(data));
  output.push("\x1b[");
  output.push("31mred\x1b");
  expect(writes.join("")).toBe("\x1b[31mred");
  vi.advanceTimersByTime(1000);
  expect(writes.join("")).toBe("\x1b[31mred\x1b");
  output.dispose();
});

it("bounds buffered output and cancels pending writes on disposal", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  const output = createTerminalOutput(write);
  const large = begin + "x".repeat(4 * 1024 * 1024);
  output.push(large);
  expect(write).toHaveBeenCalledExactlyOnceWith(large);
  output.push(begin + "old session");
  output.dispose();
  vi.runAllTimers();
  output.push("late packet");
  output.flush();
  expect(write).toHaveBeenCalledTimes(1);
});
