import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

// jsdom has no layout engine; native tab-strip geometry is covered by the
// Tauri integration checks. Supply the browser observer API for component tests.
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};

// Radix's Popper (@floating-ui isTopLayer) probes every ancestor of an open menu with :modal /
// :popover-open / :fullscreen. jsdom's nwsapi evaluates them by re-entering its own matcher
// recursively: ~30 s of CPU per menu (node --cpu-prof, dssh/T96). Nothing is ever in the top layer
// in jsdom, so answer false like a real browser does, without the recursion.
const nativeMatches = Element.prototype.matches;
const JSDOM_TOP_LAYER_SELECTORS = new Set([":modal", ":popover-open", ":fullscreen"]);
Element.prototype.matches = function (selector: string) {
  if (JSDOM_TOP_LAYER_SELECTORS.has(selector)) return false;
  return nativeMatches.call(this, selector);
};

afterEach(async () => {
  cleanup();
  localStorage.clear();
  // Let Vitest flush worker IPC between expensive Radix/jsdom focus tests.
  await yieldToEventLoop();
});
