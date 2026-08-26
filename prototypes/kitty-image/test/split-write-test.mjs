// 边界测试：Kitty 序列被拆成多个小 write() 时，ghostty-web 能否正确重组
import { chromium } from "playwright";
import { readFileSync, writeFileSync } from "node:fs";

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

// 读测试图，构造完整 chunked Kitty 序列（在 Node 侧生成，避免 shell 变量干扰）
const b64 = readFileSync(
  "/srv/workspace/dssh/prototypes/kitty-image/server/test.png",
).toString("base64");
const chunks = [];
for (let i = 0; i < b64.length; i += 4096) chunks.push(b64.slice(i, i + 4096));
let seq = "";
chunks.forEach((c, i) => {
  const m = i < chunks.length - 1 ? 1 : 0;
  seq +=
    i === 0 ? `\x1b_Ga=T,f=100,m=${m};${c}\x1b\\` : `\x1b_Gm=${m};${c}\x1b\\`;
});

// 按 N 字节一个 write() 拆分发送（模拟 tmux 的碎包转发）
const SPLIT = 997;
await page.evaluate(
  async ({ seq, SPLIT }) => {
    for (let i = 0; i < seq.length; i += SPLIT) {
      window.__term.write(seq.slice(i, i + SPLIT));
      await new Promise((r) => setTimeout(r, 5));
    }
  },
  { seq, SPLIT },
);
await page.waitForTimeout(2500);
writeFileSync("/tmp/split-result.png", await page.screenshot());

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
    ? "2. 碎包 write 图片渲染 ✓（/tmp/split-result.png）"
    : "2. 碎包 write 未渲染 ✗",
);
process.exitCode = hasImage ? 0 : 1;
await browser.close();
