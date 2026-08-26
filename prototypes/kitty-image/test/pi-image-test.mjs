// 真实 pi 端到端测试：在 web 终端里跑 pi，让它读图片，验证图片内联渲染
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.DEMO_URL || 'http://localhost:5173';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto(URL);
await page.waitForSelector('.terminal-container canvas', { timeout: 15000 });
await page.waitForFunction(() => document.querySelector('.status')?.textContent === '已连接', {
  timeout: 15000,
});
console.log('1. terminal ready ✓');

// 启动 pi（在 demo 目录下运行，避免无关信任提示）
await page.keyboard.type('cd /srv/workspace/dssh/prototypes/kitty-image && pi');
await page.keyboard.press('Enter');
await page.waitForTimeout(8000);
writeFileSync('/tmp/pi-tui.png', await page.screenshot());
console.log('2. pi started（截图 /tmp/pi-tui.png）');

// 让 pi 读取测试图片
await page.keyboard.type('读取 server/test.png 这张图片，用一句话告诉我它是什么', { delay: 20 });
await page.keyboard.press('Enter');
console.log('3. prompt sent，等待 pi 响应…');

// pi 工作可能需要较长时间（读图 + 模型往返），轮询截图观察
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(10000);
  writeFileSync('/tmp/pi-result.png', await page.screenshot());
  // 简单终止条件：canvas 上出现非背景的彩色像素块（我们的测试图是渐变色）
  const hasImage = await page.evaluate(() => {
    const canvas = document.querySelector('.terminal-container canvas');
    if (!canvas) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < data.length; i += 16) {
      const r = data[i], g = data[i + 1], b = data[i + 2];
      // 测试图特征：饱和的紫/青渐变
      if (b > 150 && r > 60 && g < 120) colored++;
    }
    return colored > 200;
  });
  if (hasImage) {
    console.log(`4. 检测到图片像素 ✓（第 ${i + 1} 次轮询，截图 /tmp/pi-result.png）`);
    await browser.close();
    process.exit(0);
  }
}
console.log('4. 120s 内未检测到图片渲染 ✗（截图 /tmp/pi-result.png 供人工检查）');
process.exitCode = 1;
await browser.close();
