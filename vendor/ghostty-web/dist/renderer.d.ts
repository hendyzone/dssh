import { ITerminalDecoration, ITheme } from './interfaces';
import { SelectionManager } from './selection-manager';
import { GhosttyCell, KittyImagePixels, KittyPlacementInfo } from './types';
export interface IRenderable {
    getLine(y: number): GhosttyCell[] | null;
    getViewport?(): GhosttyCell[];
    getCursor(): {
        x: number;
        y: number;
        visible: boolean;
        style?: 'block' | 'underline' | 'bar';
    };
    getDimensions(): {
        cols: number;
        rows: number;
    };
    isRowDirty(y: number): boolean;
    /** Returns true if a full redraw is needed (e.g., screen change) */
    needsFullRedraw?(): boolean;
    clearDirty(): void;
    /**
     * Get the full grapheme string for a cell at (row, col).
     * For cells with grapheme_len > 0, this returns all codepoints combined.
     * For simple cells, returns the single character.
     */
    getGraphemeString?(row: number, col: number): string;
    getKittyGraphics?(): number | null;
    iterPlacements?(graphics: number, onlyVisible?: boolean): Iterable<KittyPlacementInfo>;
    getKittyImagePixels?(graphics: number, imageId: number): KittyImagePixels | null;
    /**
     * Returns the full codepoint sequence for the cell at (row, col) in
     * the active screen — the base codepoint followed by any combining
     * marks. Used to decode unicode-placeholder cells (U+10EEEE plus
     * combining diacritics that encode row/column slice positions).
     */
    getGrapheme?(row: number, col: number): number[] | null;
}
export interface IScrollbackProvider {
    getScrollbackLine(offset: number): GhosttyCell[] | null;
    getScrollbackLength(): number;
}
export declare const DEFAULT_SCROLLBAR_WIDTH = 8;
export interface RendererOptions {
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    cursorStyle?: 'block' | 'underline' | 'bar';
    cursorBlink?: boolean;
    theme?: ITheme;
    devicePixelRatio?: number;
    scrollbarWidth?: number;
    allowTransparency?: boolean;
}
export interface FontMetrics {
    width: number;
    height: number;
    baseline: number;
}
export declare const DEFAULT_THEME: Required<ITheme>;
export declare class CanvasRenderer {
    private canvas;
    private ctx;
    private fontSize;
    private fontFamily;
    private fontWeight;
    private cursorStyle;
    private cursorBlink;
    private theme;
    private allowTransparency;
    private devicePixelRatio;
    private readonly fixedDevicePixelRatio?;
    private scrollbarWidth;
    private metrics;
    private fontStrings;
    private cursorVisible;
    private cursorBlinkInterval?;
    private lastCursorPosition;
    private onRequestRender;
    private lastViewportY;
    private currentBuffer;
    /**
     * Decoded kitty graphics images, keyed by image id. Each entry caches
     * a canvas painted from the WASM-side RGBA bytes so per-frame compositing
     * is just a drawImage call.
     *
     * Staleness key combines width/height/format/dataPtr/dataLen — the
     * kitty protocol allows reusing an id with new bytes, and dataLen alone
     * is too weak (transposed dims or format change can keep byte count
     * identical). dataPtr is the WASM byteOffset, which changes whenever
     * ghostty frees + re-allocates the image bytes (i.e., on retransmit).
     */
    private kittyImageCache;
    /**
     * Per-frame index of virtual placements keyed by image id. Populated
     * once at the start of each render() pass (cheap — typically zero or
     * a handful of entries). Looked up by U+10EEEE placeholder cells in
     * renderPlaceholderCell to find the placement's grid dimensions.
     */
    private kittyVirtualPlacements;
    /**
     * Direct (non-virtual) placements that need compositing this frame.
     * Built once per render() in precomputeKittyState so renderKittyImages
     * doesn't re-walk the iterator. Empty when no kitty graphics are active.
     */
    private currentDirectPlacements;
    /**
     * Last frame's direct-placement signatures, keyed by image id. Used to
     * detect placement add/remove/move/redecode so we can mark the affected
     * rows for repaint (clearing stale image pixels) and skip the composite
     * pass entirely when nothing has changed. dataLen is the same staleness
     * discriminator used by kittyImageCache.
     */
    private lastKittyDirectSigs;
    /**
     * Rows whose image footprint changed since last frame (placement added,
     * removed, moved, resized, or re-decoded under the same id). Added to
     * rowsToRender so the underlying text repaints — which clears stale
     * image pixels — before we composite the current placements on top.
     */
    private kittyDamagedRows;
    /**
     * Cached IRenderable on the current render() call so renderCellText
     * can call into it (e.g. getGrapheme) without us threading the buffer
     * through every helper. Set at the top of render(), cleared at the end.
     */
    private currentRenderBuffer;
    private currentKittyGraphics;
    private selectionManager?;
    private currentSelectionCoords;
    private hoveredHyperlinkId;
    private previousHoveredHyperlinkId;
    private hoveredLinkRange;
    private previousHoveredLinkRange;
    private decorations;
    private previousDecorationRows;
    private currentDecorationRows;
    private currentScrollbackLength;
    private currentViewportY;
    private overlayCanvas;
    private overlayCtx;
    constructor(canvas: HTMLCanvasElement, options?: RendererOptions);
    private buildFontStrings;
    private getFontString;
    private getDevicePixelRatio;
    private measureFont;
    /**
     * Remeasure font metrics (call after font loads or changes).
     * Rebuilds cached font strings so Canvas2D picks up newly-loaded font files.
     */
    remeasureFont(): void;
    private rgbToCSS;
    /**
     * Resize canvas to fit terminal dimensions
     */
    resize(cols: number, rows: number): void;
    /**
     * Render the terminal buffer to canvas
     */
    render(buffer: IRenderable, forceAll?: boolean, viewportY?: number, scrollbackProvider?: IScrollbackProvider, scrollbarOpacity?: number): void;
    /**
     * Render a single line using two-pass approach:
     * 1. First pass: Draw all cell backgrounds
     * 2. Second pass: Draw all cell text and decorations
     *
     * This two-pass approach is necessary for proper rendering of complex scripts
     * like Devanagari where diacritics (like vowel sign ि) can extend LEFT of the
     * base character into the previous cell's visual area. If we draw backgrounds
     * and text in a single pass (cell by cell), the background of cell N would
     * cover any left-extending portions of graphemes from cell N-1.
     */
    private renderLine;
    /**
     * Render a cell's background only (Pass 1 of two-pass rendering)
     * Selection highlighting is integrated here to avoid z-order issues with
     * complex glyphs (like Devanagari) that extend outside their cell bounds.
     */
    private renderCellBackground;
    private getDecorationAt;
    private drawHorizontalLine;
    /**
     * Render a cell's text and decorations (Pass 2 of two-pass rendering)
     * Selection foreground color is applied here to match the selection background.
     */
    private renderCellText;
    /**
     * Render block drawing characters as filled rectangles for pixel-perfect rendering.
     * Returns true if the character was handled, false if it should be rendered as text.
     */
    private renderBlockChar;
    private strokeWithFillColor;
    /**
     * Render Unicode box-drawing character (U+2500-U+257F) as geometric lines.
     * Font glyphs for these often don't connect between adjacent cells.
     */
    private renderBoxDrawing;
    private getBoxDrawingSegments;
    /**
     * Render double-line box drawing (U+2550-U+256C) as two parallel lines.
     * Returns true if rendered, false to fall back to font.
     */
    private renderDoubleBoxDrawing;
    /**
     * Render Powerline glyphs as vector shapes for pixel-perfect cell height.
     * Powerline glyphs (U+E0B0-U+E0BF) are designed to span the full cell height,
     * but font rendering often makes them slightly taller/shorter than the cell.
     * Drawing them as paths ensures they exactly fill the cell bounds.
     * Returns true if the character was handled, false if it should be rendered as text.
     */
    private renderPowerlineGlyph;
    /**
     * Walk the placement iterator once at frame start, partitioning the
     * results: virtual placements go into kittyVirtualPlacements (keyed
     * by image id) for placeholder-cell lookup; direct visible placements
     * stay implicit and get re-iterated by renderKittyImages later.
     *
     * Also caches the storage handle for renderPlaceholderCell so the
     * per-cell hot path doesn't have to re-resolve it.
     */
    private precomputeKittyState;
    /**
     * Get (or decode + cache) the canvas-ready bitmap for a kitty image.
     * Returns null if the image isn't stored or decode fails. Shared by
     * renderKittyImages (direct placements) and renderPlaceholderCell
     * (unicode-placeholder cells).
     */
    private getOrDecodeKittyImage;
    /**
     * Substitute a cell's text rendering with a slice of a kitty graphics
     * image. Called from renderCellText when the cell's codepoint is
     * U+10EEEE.
     *
     * Decodes the image_id from cell.fg_*  (low 24 bits; high byte from
     * an optional third combining diacritic) and the row/col-of-image
     * from the first two combining diacritics on the cell. Looks up the
     * virtual placement (from precomputeKittyState) for grid dims, then
     * draws the matching slice scaled to one terminal cell.
     *
     * Returns true if the cell was handled as a placeholder; false to
     * fall through to normal text rendering (e.g., unknown image, no
     * matching virtual placement, or malformed diacritics).
     */
    private renderPlaceholderCell;
    private renderKittyImages;
    /**
     * Decode a kitty graphics image into a canvas suitable for drawImage.
     * Expands non-RGBA formats into RGBA via putImageData; PNG payloads
     * (which require a JS-side decoder set up via ghostty_sys_set) are
     * not supported in this MVP and return null.
     */
    private decodeKittyImageToCanvas;
    /**
     * Render cursor
     */
    private renderCursor;
    /**
     * Set a callback the renderer invokes when its internal state changes
     * outside the normal render-driven path (today: cursor-blink toggles).
     * Lets an event-driven Terminal wake its render scheduler instead of
     * polling every frame to catch the blink flip.
     */
    setOnRequestRender(fn: (() => void) | null): void;
    private startCursorBlink;
    private stopCursorBlink;
    /**
     * Update theme colors
     */
    setTheme(theme: ITheme): void;
    setAllowTransparency(allowTransparency: boolean): void;
    /**
     * Set general-purpose decorations in absolute buffer coordinates.
     * Decorations are painted as cell backgrounds before text rendering.
     */
    setDecorations(decorations: ITerminalDecoration[]): void;
    clearDecorations(): void;
    /**
     * Update font size
     */
    setFontSize(size: number): void;
    /**
     * Update font family
     */
    setFontFamily(family: string): void;
    setFontWeight(weight: number): void;
    /**
     * Update cursor style
     */
    setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
    /**
     * Enable/disable cursor blinking
     */
    setCursorBlink(enabled: boolean): void;
    setScrollbarWidth(width: number): void;
    /**
     * Render scrollbar (Phase 2)
     * Shows scroll position and allows click/drag interaction
     * @param opacity Opacity level (0-1) for fade in/out effect
     */
    private renderScrollbar;
    getMetrics(): FontMetrics;
    /**
     * Get canvas element (needed by SelectionManager)
     */
    getCanvas(): HTMLCanvasElement;
    /**
     * Set selection manager (for rendering selection)
     */
    setSelectionManager(manager: SelectionManager): void;
    /**
     * Check if a cell at (x, y) is within the current selection.
     * Uses cached selection coordinates for performance.
     */
    private isInSelection;
    /**
     * Set the currently hovered hyperlink ID for rendering underlines
     */
    setHoveredHyperlinkId(hyperlinkId: number): void;
    /**
     * Set the currently hovered link range for rendering underlines (for regex-detected URLs)
     * Pass null to clear the hover state
     */
    setHoveredLinkRange(range: {
        startX: number;
        startY: number;
        endX: number;
        endY: number;
    } | null): void;
    /**
     * Get character cell width (for coordinate conversion)
     */
    get charWidth(): number;
    /**
     * Get character cell height (for coordinate conversion)
     */
    get charHeight(): number;
    /**
     * Clear entire canvas
     */
    clear(): void;
    /**
     * Attach (or re-attach) the overlay canvas to a parent element.
     * Idempotent: if already attached to the same parent, does nothing.
     * Call this from Terminal.open() after the main canvas is added.
     */
    attachOverlayTo(parent: HTMLElement): void;
    /**
     * Resize the overlay canvas to match the main canvas dimensions (CSS + physical pixels).
     * Call whenever the main canvas is resized.
     */
    resizeOverlay(): void;
    /**
     * Draw preedit (IME active composition) text at the given cell coordinates.
     * Clears any previous preedit drawing first.
     * @param text  Active composition string (empty string = clear only)
     * @param cellX Column index (0-based)
     * @param cellY Row index (0-based)
     */
    drawPreedit(text: string, cellX: number, cellY: number): void;
    /**
     * Clear the preedit overlay without drawing new text.
     */
    clearPreedit(): void;
    /**
     * Cleanup resources
     */
    dispose(): void;
}
//# sourceMappingURL=renderer.d.ts.map