// IME（中文输入）自动化测试：模拟 IME 组合提交，断言中文文本到达 onData
// 运行: node test/ime-test.mjs   （需 demo dev 服务已启动）
import { chromium } from "playwright";

const URL = process.env.DEMO_URL || "http://localhost:5173";

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error") console.log("[browser error]", m.text());
});

await page.goto(URL);
// 等终端 canvas 出现且 ws 连上
await page.waitForSelector(".terminal-container canvas", { timeout: 15000 });
await page.waitForFunction(
  () => document.querySelector(".status")?.textContent === "已连接",
  {
    timeout: 15000,
  },
);
console.log("1. terminal ready ✓");

// 聚焦终端隐藏 textarea
await page.locator(".terminal-container textarea").first().focus();

// 基线：普通英文输入
await page.keyboard.type("echo hi");
await page.waitForFunction(() => window.__sent?.join("").includes("echo hi"), {
  timeout: 5000,
});
console.log("2. plain typing ✓");

// IME 模拟：组合中插入拼音，再提交中文
const cdp = await page.context().newCDPSession(page);
await cdp.send("Input.imeSetComposition", {
  text: "ni hao",
  selectionStart: 6,
  selectionEnd: 6,
});
await cdp.send("Input.insertText", { text: "你好" });

try {
  await page.waitForFunction(() => window.__sent?.join("").includes("你好"), {
    timeout: 5000,
  });
  console.log("3. IME composition commit ✓ — 中文成功送达 onData");
} catch {
  const sent = await page.evaluate(() => window.__sent);
  console.error("3. IME FAIL — __sent =", JSON.stringify(sent));
  process.exitCode = 1;
}

await browser.close();
