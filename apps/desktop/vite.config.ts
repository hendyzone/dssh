import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  define: {__AGENT_PLAYBOOK__:JSON.stringify(readFileSync(new URL("../../docs/agent-playbook.md",import.meta.url),"utf8"))},
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": new URL("./src", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
  },
});
