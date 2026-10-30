/**
 * Uses the real ghostty-web package (vendor dist), not vi.mock("ghostty-web").
 * Mutation: `git checkout origin/main -- vendor/ghostty-web/dist` → this file must fail.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InputHandler } from "ghostty-web";

const distJs = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../vendor/ghostty-web/dist/ghostty-web.js");

function stubGhostty() {
  return {
    createKeyEncoder: () => ({
      setOption: () => {},
      encode: () => new Uint8Array(0),
    }),
  } as any;
}

describe("ghostty-web built dist", () => {
  it("ships plainTextUrlLinks and suppressMouseReport in the compiled bundle", () => {
    const js = readFileSync(distJs, "utf8");
    expect(js).toContain("plainTextUrlLinks");
    expect(js).toContain("suppressMouseReport");
  });

  it("suppressMouseReport skips mouse reporting when Ctrl is held (tmux mouse mode)", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const data: string[] = [];
    const tracking = {
      hasMouseTracking: () => true,
      hasSgrMouseMode: () => true,
      getCellDimensions: () => ({ width: 10, height: 20 }),
      getCanvasOffset: () => ({ left: 0, top: 0 }),
      suppressMouseReport: (event: MouseEvent) => event.ctrlKey || event.metaKey,
    };
    const handler = new InputHandler(
      stubGhostty(),
      container,
      (chunk) => data.push(chunk),
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tracking,
    );
    try {
      container.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 5, clientY: 10, bubbles: true }));
      expect(data.length).toBe(1);
      data.length = 0;
      container.dispatchEvent(new MouseEvent("mousedown", { button: 0, clientX: 5, clientY: 10, ctrlKey: true, bubbles: true }));
      expect(data.length).toBe(0);
    } finally {
      handler.dispose();
      container.remove();
    }
  });
});

afterEach(() => {
  document.body.replaceChildren();
});
