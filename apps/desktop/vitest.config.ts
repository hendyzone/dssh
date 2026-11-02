import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

export default defineConfig({
  define: {__APP_CHANGELOG__:JSON.stringify(readFileSync(new URL("../../CHANGELOG.md",import.meta.url),"utf8")),__AGENT_PLAYBOOK__:JSON.stringify(readFileSync(new URL("../../docs/agent-playbook.md",import.meta.url),"utf8"))},
  plugins: [react()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    clearMocks: true,
  },
});
