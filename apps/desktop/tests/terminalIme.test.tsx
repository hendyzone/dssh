import { expect, it, vi } from "vitest";
import type { Terminal } from "ghostty-web";
import { trackTerminalIme } from "../src/lib/terminalIme";

it("anchors IME at the canvas cursor and follows rendering without changing composed text", () => {
  const root = document.createElement("div");
  root.innerHTML = "<canvas></canvas><textarea></textarea>";
  const input = root.querySelector("textarea")!;
  input.value = "正在输入";
  const cursor = { x: 4, y: 30 };
  let render = () => {};
  const dispose = vi.fn();
  const terminal = {
    cols: 80,
    rows: 40,
    viewportY: 0,
    options: { fontSize: 14 },
    renderer: { charWidth: 8, charHeight: 18 },
    wasmTerm: { getCursor: () => cursor },
    onRender: (callback: () => void) => {
      render = callback;
      return { dispose };
    },
    onResize: () => ({ dispose }),
  } as unknown as Terminal;
  const cleanup = trackTerminalIme(terminal, root);
  expect(input.style.left).toBe("32px");
  expect(input.style.top).toBe("540px");
  expect(input.style.height).toBe("18px");
  cursor.y = 35;
  cursor.x = 10;
  render();
  expect(input.style.top).toBe("630px");
  expect(input.style.left).toBe("80px");
  input.style.top = "0px";
  input.dispatchEvent(new Event("compositionstart", { bubbles: true }));
  expect(input.style.top).toBe("630px");
  expect(input.value).toBe("正在输入");
  cleanup();
  expect(dispose).toHaveBeenCalledTimes(2);
});
