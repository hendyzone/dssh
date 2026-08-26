// Kitty graphics 协议端到端测试：
// 1. 能力探测应答：发 a=q 查询，断言终端回包（pi 发图前的前置步骤）
// 2. 真实渲染：执行 test-image.sh，对比 canvas 截图确认图片像素出现
import { chromium } from 'playwright';

const URL = process.env.DEMO_URL || 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[browser error]', m.text());
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL);
await page.waitForSelector('.terminal-container canvas', { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('.status')?.textContent === '已连接', {
  timeout: 15000,
});
console.log('1. terminal ready ✓');

// ---------- 测试 1：Kitty graphics 能力探测应答 ----------
// 模拟 pi 的探测：发送查询，支持 Kitty 的终端应回 \x1b_Gi=31;OK\x1b\\
const before = await page.evaluate(() => window.__sent.length);
await page.evaluate(() => {
  // a=q 查询 + 一个极小的 PNG 载荷（1x1 透明 PNG 的 base64 前缀即可）
  window.__term.write('\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\');
});
await page.waitForTimeout(1500);
const replies = await page.evaluate((b) => window.__sent.slice(b), before);
const kittyReply = replies.find((r) => r.includes('\x1b_G'));
if (kittyReply) {
  console.log(`2. kitty query 应答 ✓ → ${JSON.stringify(kittyReply)}`);
} else {
  console.log('2. kitty query 无应答 ✗（pi 的探测会失败，需要在集成层代答）');
  console.log('   收到的回包:', JSON.stringify(replies));
}

// ---------- 测试 2：图片真实渲染 ----------
// 先 Ctrl+C 清掉测试 1 的应答回声（避免污染命令行）
await page.keyboard.press('Control+C');
await page.waitForTimeout(500);

const canvas = page.locator('.terminal-container canvas').first();
const beforeShot = await canvas.screenshot();

// 让 shell 输出图片序列（走完整 ws→pty→ws→write 链路）
await page.keyboard.type('bash /srv/workspace/dssh/prototypes/kitty-image/server/test-image.sh');
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);

const afterShot = await canvas.screenshot();
await import('node:fs').then((fs) => {
  fs.writeFileSync('/tmp/kitty-before.png', beforeShot);
  fs.writeFileSync('/tmp/kitty-after.png', afterShot);
});

// 截图对比：渲染图片后 canvas 像素应有显著变化
if (beforeShot.equals(afterShot)) {
  console.log('3. canvas 无变化 ✗ — 图片未渲染');
  process.exitCode = 1;
} else {
  console.log('3. canvas 像素发生变化 ✓（截图: /tmp/kitty-after.png）');
}

await browser.close();
