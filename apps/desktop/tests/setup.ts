import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

afterEach(async () => {
  cleanup();
  localStorage.clear();
  // Let Vitest flush worker IPC between expensive Radix/jsdom focus tests.
  await yieldToEventLoop();
});
