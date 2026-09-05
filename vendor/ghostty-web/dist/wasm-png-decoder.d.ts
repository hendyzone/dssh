/**
 * Minimal vendored synchronous PNG decoder wrapper for Ghostty's kitty graphics callback.
 *
 * Source: @cf-wasm/png 0.3.3, trimmed to the wasm-bindgen runtime pieces we need:
 *   - vendor/cf-wasm-png/png.js
 *   - vendor/cf-wasm-png/png_bg.wasm.inline.js
 *
 * The Ghostty DECODE_PNG callback is synchronous, so browser APIs such as
 * createImageBitmap() are not usable here. This wrapper initializes the vendored
 * PNG WASM module synchronously once and exposes a small RGBA-normalizing API.
 */
export declare enum WasmPngColorType {
    Grayscale = 0,
    RGB = 2,
    Indexed = 3,
    GrayscaleAlpha = 4,
    RGBA = 6
}
export declare enum WasmPngBitDepth {
    One = 1,
    Two = 2,
    Four = 4,
    Eight = 8,
    Sixteen = 16
}
export interface WasmPngDecodeResult {
    image: ArrayLike<number>;
    width: number;
    height: number;
    colorType: WasmPngColorType;
    bitDepth: WasmPngBitDepth;
    lineSize: number;
}
export interface DecodedRgbaPng {
    width: number;
    height: number;
    rgba: Uint8Array;
}
export declare function decodePngToRgba8(pngBytes: Uint8Array): DecodedRgbaPng | null;
//# sourceMappingURL=wasm-png-decoder.d.ts.map