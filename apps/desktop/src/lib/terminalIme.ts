import type { Terminal } from "ghostty-web";

/** Keep Chromium's editable caret at the canvas cursor, including native IME input. */
export function trackTerminalIme(terminal: Terminal, root: HTMLElement, canFocus = () => true) {
  const textarea = root.querySelector("textarea");
  const canvas = root.querySelector("canvas");
  if (!textarea || !canvas) return () => {};
  const view = root.ownerDocument.defaultView!;
  let frame = 0;
  let clearTimer = 0;
  let composing = false;
  let disposed = false;
  textarea.wrap = "off";
  root.removeAttribute("contenteditable");
  root.tabIndex = -1;
  const update = () => {
    if (disposed || composing) return;
    const renderer = terminal.renderer;
    const cursor = terminal.wasmTerm?.getCursor();
    if (!renderer || !cursor) return;
    const height = renderer.charHeight;
    const width = renderer.charWidth;
    const x = Math.max(0, Math.min(cursor.x, terminal.cols - 1)) * width;
    const y =
      Math.max(0, Math.min(cursor.y + terminal.viewportY, terminal.rows - 1)) *
      height;
    // offsetLeft/Top and font metrics are CSS pixels, independent of display DPI.
    const styles = {
      position: "absolute",
      left: `${canvas.offsetLeft + x}px`,
      top: `${canvas.offsetTop + y}px`,
      width: `${Math.max(width, (terminal.cols * width) - x)}px`,
      height: `${height}px`,
      fontSize: `${terminal.options.fontSize}px`,
      fontFamily: terminal.options.fontFamily ?? "monospace",
      lineHeight: `${height}px`,
      padding: "0",
      border: "0",
      outline: "none",
      boxShadow: "none",
      borderRadius: "0",
      appearance: "none",
      margin: "0",
      opacity: "1",
      color: "transparent",
      caretColor: "transparent",
      background: "transparent",
      zIndex: "2",
      whiteSpace: "pre",
      clipPath: "none",
      pointerEvents: "none",
    };
    for (const [key, value] of Object.entries(styles)) {
      if (textarea.style[key as keyof typeof styles] !== value)
        textarea.style[key as keyof typeof styles] = value;
    }
  };
  const tick = () => {
    frame = 0;
    if (disposed || root.ownerDocument.activeElement !== textarea) return;
    update();
    frame = view.requestAnimationFrame(tick);
  };
  const focus = (event: Event) => {
    if (event.target === root && canFocus()) textarea.focus({ preventScroll: true });
    if (root.ownerDocument.activeElement === textarea && !frame) tick();
  };
  const stop = () => { view.cancelAnimationFrame(frame); frame = 0; };
  const startComposition = () => {
    view.clearTimeout(clearTimer);
    update();
    composing = true;
    textarea.style.color = terminal.options.theme?.foreground ?? "#ffffff";
    textarea.style.background = terminal.options.theme?.background ?? "#1a1b26";
  };
  const endComposition = () => {
    composing = false;
    // The final input event follows compositionend. Clear only after it has
    // reached ghostty, never during an active native composition.
    clearTimer = view.setTimeout(() => {
      if (disposed || composing) return;
      textarea.value = "";
      textarea.scrollLeft = 0;
      textarea.scrollTop = 0;
      update();
    }, 0);
  };
  const listeners = [terminal.onRender(update), terminal.onResize(update)];
  root.addEventListener("focusin", focus);
  textarea.addEventListener("blur", stop);
  textarea.addEventListener("compositionstart", startComposition, true);
  textarea.addEventListener("compositionend", endComposition);
  root.addEventListener("keydown", update, true);
  update();
  // Normal ghostty output does not fire onRender. Poll only the focused input,
  // so cursor movement and font/zoom changes are reflected in the native caret.
  if (root.ownerDocument.activeElement === textarea) tick();
  return () => {
    disposed = true;
    stop();
    view.clearTimeout(clearTimer);
    listeners.forEach((listener) => listener.dispose());
    root.removeEventListener("focusin", focus);
    textarea.removeEventListener("blur", stop);
    textarea.removeEventListener("compositionstart", startComposition, true);
    textarea.removeEventListener("compositionend", endComposition);
    root.removeEventListener("keydown", update, true);
  };
}
