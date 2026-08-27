// UI 设计评审截图：mock Tauri 后端，截欢迎页 / 设置 / 会话界面
import { chromium } from "playwright";

const URL = "http://localhost:5174";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) =>
  console.log("[pageerror]", e.message.slice(0, 200)),
);

// Tauri v2 internals mock：servers_list 返回演示数据，ssh_connect 假成功
await page.addInitScript(() => {
  const callbacks = new Map();
  let cbId = 0;
  window.__TAURI_INTERNALS__ = {
    callbacks,
    transformCallback(cb) {
      const id = ++cbId;
      callbacks.set(id, cb);
      return id;
    },
    invoke: async (cmd, args) => {
      if (cmd === "servers_list") {
        return [
          {
            id: "s1",
            name: "生产 Web 服务器",
            host: "10.0.1.10",
            port: 22,
            username: "deploy",
            group: "生产环境",
            authMethod: "publicKey",
            keyPath: "~/.ssh/id_ed25519",
            hasPassphrase: true,
          },
          {
            id: "s2",
            name: "生产数据库",
            host: "10.0.1.20",
            port: 22,
            username: "root",
            group: "生产环境",
            authMethod: "password",
            hasPassword: true,
          },
          {
            id: "s3",
            name: "测试机",
            host: "192.168.31.100",
            port: 2222,
            username: "deng",
            group: "测试",
            authMethod: "password",
            hasPassword: true,
          },
          {
            id: "s4",
            name: "家里的 NAS",
            host: "nas.home.lan",
            port: 22,
            username: "admin",
            authMethod: "password",
            hasPassword: true,
          },
        ];
      }
      if (cmd === "ssh_connect") return "mock-backend-1";
      if (cmd === "plugin:event|listen") return ++cbId;
      return null;
    },
  };
});

await page.goto(URL, { waitUntil: "networkidle" });
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/ui-1-welcome.png" });
console.log("1. 欢迎页 ✓");

// 设置弹窗
await page.click(".sidebar-actions .icon-btn:first-child");
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/ui-2-settings.png" });
console.log("2. 设置弹窗 ✓");
await page.keyboard.press("Escape");
await page
  .click(".modal-backdrop", { position: { x: 1200, y: 100 } })
  .catch(() => {});
await page.waitForTimeout(300);

// 连一台服务器（mock 连接成功，终端显示"正在连接"）+ 开监控条
await page.click(".server-item");
await page.waitForTimeout(1200);
await page.click(".monitor-toggle");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/ui-3-session.png" });
console.log("3. 会话界面 ✓");

// 浅色主题
await page.click(".sidebar-actions .icon-btn:first-child");
await page.waitForTimeout(300);
await page.click(".theme-card:last-child"); // One Light
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/ui-4-light.png" });
console.log("4. 浅色主题 ✓");

await browser.close();
