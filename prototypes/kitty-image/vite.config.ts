import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // ghostty-web 的 WASM 通过 ?url 方式作为静态资源引入，见 src/terminal.ts
  assetsInclude: ["**/*.wasm"],
  server: {
    proxy: {
      // 同 origin 转发到 pty-ws 桥（server/index.mjs，端口 39871）
      "/ws": { target: "ws://localhost:39871", ws: true },
    },
  },
});
