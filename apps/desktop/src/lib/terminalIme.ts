import type { Terminal } from "ghostty-web";

/** Keep the native IME caret next to the canvas cursor, without touching input text. */
export function trackTerminalIme(terminal: Terminal, root: HTMLElement) {
  const textarea = root.querySelector("textarea");
  const canvas = root.querySelector("canvas");
  if (!textarea || !canvas) return () => {};
  const update = () => {
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
    Object.assign(textarea.style, {
      position: "absolute",
      left: `${canvas.offsetLeft + x}px`,
      top: `${canvas.offsetTop + y}px`,
      width: `${width}px`,
      height: `${height}px`,
      fontSize: `${terminal.options.fontSize}px`,
      lineHeight: `${height}px`,
      padding: "0",
      border: "0",
      margin: "0",
      opacity: "0",
      clipPath: "none",
      pointerEvents: "none",
    });
  };
  const listeners = [terminal.onRender(update), terminal.onResize(update)];
  // Capture keydown before IME starts; focus also fixes selection-menu repositioning.
  for (const event of ["keydown", "compositionstart", "focusin"])
    root.addEventListener(event, update, true);
  update();
  return () => {
    listeners.forEach((listener) => listener.dispose());
    for (const event of ["keydown", "compositionstart", "focusin"])
      root.removeEventListener(event, update, true);
  };
}
