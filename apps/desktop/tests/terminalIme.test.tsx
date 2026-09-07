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
  expect(input.style.outline).toBe("none");
  expect(input.style.boxShadow).toBe("none");
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

it("follows output without onRender and redirects container focus only when enabled", () => {
  const root = document.createElement("div");
  root.innerHTML = "<canvas></canvas><textarea></textarea>";
  document.body.append(root);
  const input = root.querySelector("textarea")!;
  let nextFrame: FrameRequestCallback = () => {};
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(fn => {nextFrame=fn; return 1;});
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const cursor = {x:2,y:1};
  let enabled = true;
  const terminal = {
    cols:80, rows:24, viewportY:0, options:{fontSize:14,fontFamily:"monospace"},
    renderer:{charWidth:8,charHeight:18}, wasmTerm:{getCursor:()=>cursor},
    onRender:()=>({dispose(){}}),onResize:()=>({dispose(){}}),
  } as unknown as Terminal;
  const cleanup = trackTerminalIme(terminal,root,()=>enabled);
  try {
    root.focus();
    expect(document.activeElement).toBe(input);
    cursor.x=20; cursor.y=10;
    nextFrame(0);
    expect(input.style.left).toBe("160px");
    expect(input.style.top).toBe("180px");
    expect(input.style.width).toBe("480px");
    input.blur(); enabled=false; root.focus();
    expect(document.activeElement).toBe(root);
    expect(cancel).toHaveBeenCalled();
  } finally {cleanup();root.remove();raf.mockRestore();cancel.mockRestore();}
});

it("preserves native composition until commit, then clears stale caret text", async () => {
  const root=document.createElement("div");root.innerHTML="<canvas></canvas><textarea></textarea>";
  const input=root.querySelector("textarea")!;
  const cursor={x:5,y:2};
  let render=()=>{};
  const terminal={cols:80,rows:24,viewportY:0,options:{fontSize:14},renderer:{charWidth:8,charHeight:18},wasmTerm:{getCursor:()=>cursor},
    onRender:(fn:()=>void)=>{render=fn;return{dispose(){}};},onResize:()=>({dispose(){}})} as unknown as Terminal;
  const cleanup=trackTerminalIme(terminal,root);
  try {
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    input.value="ni hao";cursor.x=30;render();
    expect(input.value).toBe("ni hao");
    expect(input.style.left).toBe("40px");
    input.value="你好";input.dispatchEvent(new CompositionEvent("compositionend",{data:"你好"}));
    expect(input.value).toBe("你好");
    await new Promise(resolve=>setTimeout(resolve,5));
    expect(input.value).toBe("");
    expect(input.style.left).toBe("240px");
    expect(input.style.opacity).toBe("1");
  } finally {cleanup();}
});
