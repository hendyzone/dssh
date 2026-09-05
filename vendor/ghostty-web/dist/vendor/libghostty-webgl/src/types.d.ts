export interface CellMetrics {
    width: number;
    height: number;
    baseline: number;
}
export type CursorStyle = 'block' | 'underline' | 'bar';
export interface RGBA {
    r: number;
    g: number;
    b: number;
    a: number;
}
export interface TerminalTheme {
    foreground: RGBA;
    background: RGBA;
    cursor: RGBA;
    cursorAccent: RGBA;
    selectionBackground: RGBA;
    selectionForeground: RGBA | null;
    selectionOpacity: number;
}
export interface SelectionRange {
    startCol: number;
    startRow: number;
    endCol: number;
    endRow: number;
}
export interface LinkRange {
    startX: number;
    startY: number;
    endX: number;
    endY: number;
}
export interface HyperlinkRange {
    hyperlinkId: number;
    range: LinkRange | null;
}
export interface DecorationRange {
    line: number;
    column: number;
    length: number;
    background?: RGBA;
    foreground?: RGBA;
}
export declare const ROW_DIRTY = 1;
export declare const ROW_HAS_SELECTION = 2;
export declare const ROW_HAS_HYPERLINK = 4;
export declare const DirtyState: {
    readonly NONE: 0;
    readonly PARTIAL: 1;
    readonly FULL: 2;
};
export type DirtyState = (typeof DirtyState)[keyof typeof DirtyState];
export declare const CellFlags: {
    readonly BOLD: number;
    readonly ITALIC: number;
    readonly UNDERLINE: number;
    readonly STRIKETHROUGH: number;
    readonly INVERSE: number;
    readonly INVISIBLE: number;
    readonly BLINK: number;
    readonly FAINT: number;
};
export interface GhosttyCell {
    codepoint: number;
    fg_r: number;
    fg_g: number;
    fg_b: number;
    bg_r: number;
    bg_g: number;
    bg_b: number;
    fgIsDefault?: boolean;
    bgIsDefault?: boolean;
    flags: number;
    width: number;
    hyperlink_id: number;
    grapheme_len: number;
}
export type GraphemeRow = ReadonlyArray<string | undefined>;
export type GraphemeRows = ReadonlyArray<GraphemeRow | undefined>;
export interface RenderInput {
    cols: number;
    rows: number;
    viewportCells: GhosttyCell[];
    graphemeRows: GraphemeRows;
    rowFlags: Uint8Array;
    dirtyState: DirtyState;
    selectionRange: SelectionRange | null;
    hoveredLink: HyperlinkRange | null;
    decorations: readonly DecorationRange[];
    cursorX: number;
    cursorY: number;
    cursorVisible: boolean;
    cursorStyle: CursorStyle;
    getGraphemeString?: (viewportRow: number, col: number) => string;
    theme: TerminalTheme;
    viewportY: number;
    scrollbackLength: number;
    scrollbarOpacity: number;
    scrollbarWidth: number;
    allowTransparency: boolean;
}
export interface Renderer {
    attach(canvas: HTMLCanvasElement): void;
    resize(cols: number, rows: number): void;
    render(input: RenderInput): void;
    updateTheme(theme: TerminalTheme): void;
    setFontSize(size: number): void;
    setFontFamily(family: string): void;
    getMetrics(): CellMetrics;
    getCanvas(): HTMLCanvasElement;
    readonly charWidth: number;
    readonly charHeight: number;
    clear(): void;
    dispose(): void;
    setPostProcessShader(fragmentSource: string | null): void;
}
//# sourceMappingURL=types.d.ts.map