// 图片预览命中测试验证：渲染测试图后，用 wasmTerm 公开 API 做命中测试并提取像素
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

// 渲染测试图片
await page.keyboard.type('bash /srv/workspace/dssh/prototypes/kitty-image/server/test-image.sh');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);

// 用与 apps/desktop/src/lib/kittyPreview.ts 相同的逻辑做命中测试
const result = await page.evaluate(() => {
  const term = window.__term;
  const wasmTerm = term.wasmTerm;
  const canvas = document.querySelector('.terminal-container canvas');
  if (!wasmTerm || !canvas) return { error: 'no wasmTerm/canvas' };

  const g = wasmTerm.getKittyGraphics();
  if (!g) return { error: 'no kitty graphics storage（图片没进存储？）' };

  const placements = [...wasmTerm.iterPlacements(g, true)];
  if (placements.length === 0) return { error: 'no placements' }
;
  const p = placements[0];
  // 命中测试：placement 中心点
  const cw = term.renderer.charWidth;
  const ch = term.renderer.charHeight;
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + (p.viewportCol + p.gridCols / 2) * cw;
  const cy = rect.top + (p.viewportRow + p.gridRows / 2) * ch;
  const col = Math.floor((cx - rect.left) / cw);
  const row = Math.floor((cy - rect.top) / ch);
  const hit =
    col >= p.viewportCol && col < p.viewportCol + p.gridCols &&
    row >= p.viewportRow && row < p.viewportRow + p.gridRows;

  // 提取像素（注意：借用 WASM 内存，立即复制）
  const px = wasmTerm.getKittyImagePixels(g, p.imageId);
  if (!px) return { error: 'no pixels', placement: p };
  const copy = new Uint8ClampedArray(px.data.slice(0));
  const img = new ImageData(copy, px.width, px.height);
  const c = document.createElement('canvas');
  c.width = px.width;
  c.height = px.height;
  c.getContext('2d').putImageData(img, 0, 0);

  return {
    placement: { col: p.viewportCol, row: p.viewportRow, cols: p.gridCols, rows: p.gridRows },
    hitTestSelfCheck: hit,
    pixels: { width: px.width, height: px.height, format: px.format },
    dataUrl: c.toDataURL('image/png'),
  };
});

if (result.error) {
  console.error('2. FAIL:', result.error, result.placement ?? '');
  process.exit(1);
}
console.log(`2. placement 命中 ✓ grid(${result.placement.col},${result.placement.row} ${result.placement.cols}x${result.placement.rows}格) 自检=${result.hitTestSelfCheck}`);
console.log(`3. 像素提取 ✓ ${result.pixels.width}x${result.pixels.height} format=${result.pixels.format}`);

// 把提取出的图片存盘供人工核对
const base64 = result.dataUrl.split(',')[1];
writeFileSync('/tmp/preview-extracted.png', Buffer.from(base64, 'base64'));
console.log('4. 提取图片已存 /tmp/preview-extracted.png');

await browser.close();
