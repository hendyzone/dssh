import { expect, it } from "vitest";
import { preventBrowserContextMenu } from "../src/lib/contextMenu";

it("suppresses browser menus without preventing application handlers", () => {
  const root = document.createElement("div");
  const canvas = document.createElement("canvas");
  root.append(canvas);
  document.body.append(root);
  let received = false;
  root.addEventListener("contextmenu", preventBrowserContextMenu, true);
  canvas.addEventListener("contextmenu", () => {
    received = true;
  });
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  canvas.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(received).toBe(true);
  root.remove();
});

it("keeps form editing menus but blocks terminal native menus", () => {
  const root = document.createElement("div");
  const input = document.createElement("textarea");
  root.append(input);
  root.addEventListener("contextmenu", preventBrowserContextMenu, true);
  const native = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(native);
  expect(native.defaultPrevented).toBe(false);
  root.className = "terminal-view";
  const terminal = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(terminal);
  expect(terminal.defaultPrevented).toBe(true);
});
