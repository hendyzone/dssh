import type { Terminal } from "ghostty-web";
import { isAppShortcut, isComposingKey } from "./keyboard";

/** Return to the live cursor for user input, never for PTY output or replies. */
export function trackTerminalInputScroll(
  terminal: Terminal,
  root: HTMLElement,
  canInput: () => boolean,
) {
  const reveal = () => {
    if (canInput()) terminal.scrollToBottom();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || isAppShortcut(event) || event.metaKey) return;
    // Copying and browsing history should preserve the viewport. Paste is
    // handled when its content arrives, including asynchronous screenshot uploads.
    if (
      event.ctrlKey &&
      (/^v$/i.test(event.key) || (event.shiftKey && /^c$/i.test(event.key)))
    )
      return;
    if (event.shiftKey && /^(PageUp|PageDown|Home|End)$/.test(event.key))
      return;
    if (
      isComposingKey(event) ||
      [...event.key].length === 1 ||
      /^(Enter|Backspace|Delete|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F\d{1,2})$/.test(
        event.key,
      )
    )
      reveal();
  };
  const onTextInput = (event: Event) => {
    if (!event.defaultPrevented) reveal();
  };
  root.addEventListener("keydown", onKeyDown, true);
  root.addEventListener("beforeinput", onTextInput, true);
  root.addEventListener("compositionstart", onTextInput, true);
  root.addEventListener("paste", onTextInput, true);
  const originalPaste = terminal.paste;
  const paste = (text: string) => {
    if (text) reveal();
    originalPaste.call(terminal, text);
  };
  terminal.paste = paste;
  return () => {
    root.removeEventListener("keydown", onKeyDown, true);
    root.removeEventListener("beforeinput", onTextInput, true);
    root.removeEventListener("compositionstart", onTextInput, true);
    root.removeEventListener("paste", onTextInput, true);
    if (terminal.paste === paste) terminal.paste = originalPaste;
  };
}
