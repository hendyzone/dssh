import { expect, it, vi } from "vitest";
import type { Terminal } from "ghostty-web";
import { trackTerminalInputScroll } from "../src/lib/terminalInputScroll";

function setup() {
  const root = document.createElement("div");
  const textarea = document.createElement("textarea");
  root.append(textarea);
  let enabled = true;
  const terminal = {
    viewportY: 20,
    scrollToBottom: vi.fn(() => {
      terminal.viewportY = 0;
    }),
    paste: vi.fn(),
  };
  const originalPaste = terminal.paste;
  const dispose = trackTerminalInputScroll(
    terminal as unknown as Terminal,
    root,
    () => enabled,
  );
  return {
    root,
    textarea,
    terminal,
    originalPaste,
    dispose,
    disable: () => {
      enabled = false;
    },
  };
}

it("returns from scrollback before editing keys, without consuming input", () => {
  const env = setup();
  for (const key of ["a", "你", "😀", "Enter", "Backspace", "ArrowUp", "Tab"]) {
    env.terminal.viewportY = 20;
    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
    });
    env.textarea.dispatchEvent(event);
    expect(env.terminal.viewportY).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  }
  env.dispose();
});

it("reveals the cursor before IME composition and native text input", () => {
  const env = setup();
  for (const type of ["compositionstart", "beforeinput", "paste"]) {
    env.terminal.viewportY = 20;
    env.textarea.dispatchEvent(new Event(type, { bubbles: true }));
    expect(env.terminal.viewportY).toBe(0);
  }
  env.dispose();
});

it("preserves browsing, copying, modifier keys, and application shortcuts", () => {
  const env = setup();
  for (const options of [
    { key: "Shift" },
    { key: "Control" },
    { key: "Alt" },
    { key: "c", ctrlKey: true, shiftKey: true },
    { key: "c", metaKey: true },
    { key: "v", ctrlKey: true },
    { key: "Tab", ctrlKey: true },
    { key: "w", ctrlKey: true },
    { key: "1", ctrlKey: true },
    { key: "PageUp", shiftKey: true },
  ])
    env.textarea.dispatchEvent(
      new KeyboardEvent("keydown", { ...options, bubbles: true }),
    );
  for (const type of ["wheel", "focus", "mousedown"])
    env.textarea.dispatchEvent(new Event(type, { bubbles: true }));
  expect(env.terminal.scrollToBottom).not.toHaveBeenCalled();
  expect(env.terminal.viewportY).toBe(20);
  env.dispose();
});

it("supports programmatic paste and removes its hooks on disposal", () => {
  const env = setup();
  env.terminal.paste("pasted command");
  expect(env.terminal.viewportY).toBe(0);
  expect(env.originalPaste).toHaveBeenCalledWith("pasted command");
  env.dispose();
  expect(env.terminal.paste).toBe(env.originalPaste);
  env.terminal.viewportY = 20;
  env.textarea.dispatchEvent(
    new KeyboardEvent("keydown", { key: "a", bubbles: true }),
  );
  expect(env.terminal.viewportY).toBe(20);
});

it("does not scroll inactive terminals or consume prevented input", () => {
  const env = setup();
  const event = new KeyboardEvent("keydown", {
    key: "a",
    bubbles: true,
    cancelable: true,
  });
  event.preventDefault();
  env.textarea.dispatchEvent(event);
  env.disable();
  env.textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  env.terminal.paste("text");
  expect(env.terminal.scrollToBottom).not.toHaveBeenCalled();
  env.dispose();
});
