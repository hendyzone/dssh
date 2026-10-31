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

afterEach(async () => {
  cleanup();
  localStorage.clear();
  // Let Vitest flush worker IPC between expensive Radix/jsdom focus tests.
  await yieldToEventLoop();
});
