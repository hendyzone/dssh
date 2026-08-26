// Kitty 图片命中测试与像素提取
// 利用 ghostty-web 公开的 wasmTerm（Kitty placements/像素查询），无需改动 vendor
import type { Terminal } from 'ghostty-web';

export interface ImagePreviewData {
  dataUrl: string;
  width: number;
  height: number;
}

interface Placement {
  imageId: number;
  viewportCol: number;
  viewportRow: number;
  gridCols: number;
  gridRows: number;
  viewportVisible: boolean;
}

interface WasmTermLike {
  getKittyGraphics(): number | null;
  iterPlacements(graphics: number, onlyVisible?: boolean): Iterable<Placement>;
  getKittyImagePixels(
    graphics: number,
    imageId: number,
  ): { width: number; height: number; format: number; data: Uint8Array } | null;
}

/**
 * 查找终端坐标点下的 Kitty 图片，命中则返回 PNG dataURL。
 * 坐标为相对终端容器的 clientX/clientY。
 */
export function findImageAtPoint(
  term: Terminal,
  canvas: HTMLCanvasElement,
  clientX: number,
  clientY: number,
): ImagePreviewData | null {
  const renderer = term.renderer as { charWidth?: number; charHeight?: number } | undefined;
  // SAFETY: ghostty-web 将 wasmTerm 声明为 public（供 link providers 使用），
  // 但其类型未导出完整方法签名；本地接口只声明我们用到的三个公开方法。
  const wasmTerm = (term as unknown as { wasmTerm?: WasmTermLike }).wasmTerm;
  if (!renderer?.charWidth || !renderer?.charHeight || !wasmTerm) return null;

  const rect = canvas.getBoundingClientRect();
  const col = Math.floor((clientX - rect.left) / renderer.charWidth);
  const row = Math.floor((clientY - rect.top) / renderer.charHeight);

  const graphics = wasmTerm.getKittyGraphics();
  if (!graphics) return null;

  for (const p of wasmTerm.iterPlacements(graphics, true)) {
    if (!p.viewportVisible) continue;
    const inCol = col >= p.viewportCol && col < p.viewportCol + p.gridCols;
    const inRow = row >= p.viewportRow && row < p.viewportRow + p.gridRows;
    if (!inCol || !inRow) continue;

    const px = wasmTerm.getKittyImagePixels(graphics, p.imageId);
    if (!px) return null;
    return pixelsToDataUrl(px);
  }
  return null;
}

function pixelsToDataUrl(px: {
  width: number;
  height: number;
  format: number;
  data: Uint8Array;
}): ImagePreviewData | null {
  // KittyImageFormat: RGB=0, RGBA=1, PNG=2, GRAY_ALPHA=3, GRAY=4
  if (px.format === 2) {
    // PNG 原始字节，直接转 blob
    const copy = new Uint8Array(px.data); // WASM 内存是借用的，先复制
    const blob = new Blob([copy], { type: 'image/png' });
    return { dataUrl: URL.createObjectURL(blob), width: px.width, height: px.height };
  }

  const canvas = document.createElement('canvas');
  canvas.width = px.width;
  canvas.height = px.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(px.width, px.height);

  const src = px.data;
  const dst = img.data;
  if (px.format === 1) {
    dst.set(new Uint8ClampedArray(src)); // RGBA
  } else if (px.format === 0) {
    for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
      dst[j] = src[i];
      dst[j + 1] = src[i + 1];
      dst[j + 2] = src[i + 2];
      dst[j + 3] = 255;
    }
  } else {
    return null; // GRAY 系暂不处理（罕见）
  }
  ctx.putImageData(img, 0, 0);
  return { dataUrl: canvas.toDataURL('image/png'), width: px.width, height: px.height };
}
