import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  define: {__AGENT_PLAYBOOK__:JSON.stringify(readFileSync(new URL("../../docs/agent-playbook.md",import.meta.url),"utf8"))},
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
    },
  },
  test: {
    // Radix focus cleanup is expensive in jsdom; allow IPC to flush between tests.
    testTimeout: 60000,
    hookTimeout: 60000,
    maxWorkers: 2,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.tsx"],
    clearMocks: true,
  },
});
