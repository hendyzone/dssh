import { GlyphAtlas } from './GlyphAtlas';
import { RenderInput } from './types';
export declare class CellBuffer {
    private gl;
    private buffer;
    private cols;
    private rows;
    private data;
    private u8;
    private view;
    private resolved;
    constructor(gl: WebGL2RenderingContext);
    get handle(): WebGLBuffer;
    dispose(): void;
    resize(cols: number, rows: number): void;
    private static shouldDebugCells;
    update(input: RenderInput, atlas: GlyphAtlas, forceFullUpload: boolean): void;
    private writeRow;
    private resolveLegacyGraphemeRows;
    private resolveLegacyGraphemeRow;
    private writeEmptyCell;
}
//# sourceMappingURL=CellBuffer.d.ts.map