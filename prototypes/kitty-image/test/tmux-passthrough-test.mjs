// tmux DCS passthrough 测试：tmux(allow-passthrough) 内发包装后的 Kitty 序列，验证图片渲染
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const URL = process.env.DEMO_URL || "http://localhost:5173";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

await page.goto(URL);
await page.waitForSelector(".terminal-container canvas", { timeout: 15000 });
await page.waitForFunction(
  () => document.querySelector(".status")?.textContent === "已连接",
  {
    timeout: 15000,
  },
);
console.log("1. terminal ready ✓");

// 记录所有到达终端的 write 数据（检测 tmux 透传后的序列形态）
await page.evaluate(() => {
  window.__writes = [];
  const orig = window.__term.write.bind(window.__term);
  window.__term.write = (d) => {
    window.__writes.push(d);
    return orig(d);
  };
});

// 启动带 passthrough 的 tmux（独立 socket：-f 仅在建新 server 时生效）
await page.keyboard.type(
  "printf 'set -g allow-passthrough on\\n' > /tmp/tmux-pc.conf && tmux -L dsshtest -f /tmp/tmux-pc.conf new-session",
);
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);

// 断言 passthrough 真的开了
await page.keyboard.type("tmux show -g allow-passthrough", { delay: 10 });
await page.keyboard.press("Enter");
await page.waitForTimeout(1000);
console.log("2. tmux started（独立 socket，已查询 allow-passthrough 状态）");

// 发送 DCS 包装的 Kitty 图片序列
await page.keyboard.type(
  "bash /srv/workspace/dssh/prototypes/kitty-image/server/test-image-tmux.sh",
  { delay: 10 },
);
await page.keyboard.press("Enter");
await page.waitForTimeout(3000);

writeFileSync("/tmp/tmux-result.png", await page.screenshot());

// 检查到达终端的数据里有没有完整的 Kitty APC 序列
const apcInfo = await page.evaluate(() => {
  const hits = window.__writes.filter((w) => w.includes("\x1b_G"));
  return {
    count: hits.length,
    sample: hits[0] ? JSON.stringify(hits[0].slice(0, 80)) : null,
  };
});
console.log("   APC 序列到达数:", apcInfo.count, "样例:", apcInfo.sample);

const hasImage = await page.evaluate(() => {
  const canvas = document.querySelector(".terminal-container canvas");
  if (!canvas) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let colored = 0;
  for (let i = 0; i < data.length; i += 16) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    if (b > 150 && r > 60 && g < 120) colored++;
  }
  return colored > 200;
});

console.log(
  hasImage
    ? "3. tmux 内图片渲染 ✓（截图 /tmp/tmux-result.png）"
    : "3. 未检测到图片 ✗",
);
process.exitCode = hasImage ? 0 : 1;
await browser.close();
