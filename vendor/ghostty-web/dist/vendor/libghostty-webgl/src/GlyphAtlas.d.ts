export interface GlyphMetrics {
    atlasX: number;
    atlasY: number;
    atlasW: number;
    atlasH: number;
    bearingX: number;
    bearingY: number;
    width: number;
    height: number;
    isColor: boolean;
}
export declare class GlyphAtlas {
    private gl;
    private fontSize;
    private fontFamily;
    private fontWeight;
    private dpr;
    private atlasSize;
    private colorAtlasSize;
    private atlasTexture;
    private colorTexture;
    private page;
    private colorPage;
    private glyphs;
    private useCounter;
    private canvas;
    private ctx;
    private colorCanvas;
    private colorCtx;
    constructor(gl: WebGL2RenderingContext, fontSize: number, fontFamily: string, fontWeight: number, dpr: number);
    get texture(): WebGLTexture;
    get colorAtlas(): WebGLTexture;
    get size(): number;
    get colorSize(): number;
    dispose(): void;
    reset(fontSize: number, fontFamily: string, fontWeight: number, dpr: number): void;
    getGlyph(grapheme: string, bold: boolean, italic: boolean): GlyphMetrics;
    private initTextures;
    private prewarmAscii;
    private addGlyph;
    private tryRasterizeGlyph;
    private evictLeastRecentlyUsedShelf;
    private findEvictionShelf;
    private clearShelfTexture;
    private repackAndAddGlyph;
    private resetPage;
    private clearFullPageTexture;
    private createPlaceholder;
    private resetPages;
    private recreateTextures;
    private makeKey;
}
//# sourceMappingURL=GlyphAtlas.d.ts.map