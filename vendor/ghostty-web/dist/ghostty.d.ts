import { CellFlags, Cursor, DirtyState, GhosttyCell, GhosttyTerminalConfig, GhosttyWasmExports, KeyEncoderOption, KeyEvent, KittyImagePixels, KittyKeyFlags, KittyPlacementInfo, RGB, RenderStateColors, RenderStateCursor } from './types';
export { CellFlags, type Cursor, DirtyState, type GhosttyCell, type GhosttyTerminalConfig, KeyEncoderOption, type RGB, type RenderStateColors, type RenderStateCursor, };
/**
 * Main Ghostty WASM wrapper class
 */
export declare class Ghostty {
    private exports;
    private memory;
    constructor(wasmInstance: WebAssembly.Instance);
    createKeyEncoder(): KeyEncoder;
    createTerminal(cols?: number, rows?: number, config?: GhosttyTerminalConfig): GhosttyTerminal;
    static load(wasmPath?: string): Promise<Ghostty>;
    private static loadFromPath;
    /**
     * Load and instantiate the Ghostty WASM module from a pre-fetched ArrayBuffer.
     *
     * This is the fast path when bytes are already available (e.g. from an
     * IndexedDB cache). It skips the fetch round-trip but still compiles the
     * module — use `loadFromResponse` to also overlap compilation with the
     * download via `instantiateStreaming`.
     */
    static loadFromBytes(bytes: ArrayBuffer): Promise<Ghostty>;
    /**
     * Load and instantiate the Ghostty WASM module from a fetch `Response`.
     *
     * Uses `WebAssembly.instantiateStreaming` when the response carries the
     * required `Content-Type: application/wasm` header, allowing compilation
     * to overlap with the download. Falls back to `arrayBuffer()` + `compile`
     * if streaming is unavailable or the Content-Type is wrong.
     */
    static loadFromResponse(response: Response): Promise<Ghostty>;
    /**
     * Compile and instantiate a pre-compiled WASM module.
     * Shared by `loadFromPath`, `loadFromBytes`, and the streaming fallback.
     */
    private static _instantiateFromModule;
    /**
     * Build the WebAssembly imports object with the WASM-to-host `log` callback.
     * Returns a `setInstance` setter that must be called after instantiation so
     * the callback can access the instance's memory buffer.
     * Safe because WASM only calls `log` after full instantiation.
     */
    private static _makeImports;
}
/**
 * Key Encoder - converts keyboard events into terminal escape sequences
 */
export declare class KeyEncoder {
    private exports;
    private encoder;
    constructor(exports: GhosttyWasmExports);
    setOption(option: KeyEncoderOption, value: boolean | number): void;
    setKittyFlags(flags: KittyKeyFlags): void;
    encode(event: KeyEvent): Uint8Array;
    dispose(): void;
}
/**
 * GhosttyTerminal - High-performance terminal emulator
 *
 * Uses Ghostty's native RenderState for optimal performance:
 * - ONE call to update all state (renderStateUpdate)
 * - ONE call to get all cells (getViewport)
 * - No per-row WASM boundary crossings!
 */
export declare class GhosttyTerminal {
    private exports;
    private memory;
    private handle;
    private renderHandle;
    private rowIter;
    private rowCells;
    private _cols;
    private _rows;
    /** Cell pool for zero-allocation rendering */
    private cellPool;
    /** Active viewport decoded once per terminal mutation. */
    private viewportCache;
    /** Mutation-invalidated LRU for expensive historical row decoding. */
    private readonly scrollbackLineCache;
    private static readonly SCROLLBACK_LINE_CACHE_LIMIT;
    /**
     * Cell pixel dimensions last pushed to the WASM terminal via
     * ghostty_terminal_resize. Zero means "unknown / disabled" — kitty
     * graphics image sizing and CSI 14/16/18 t in-band size reports will
     * return zero/no-op until setCellPixelSize() is called with real values.
     */
    private cellWidthPx;
    private cellHeightPx;
    /**
     * Per-row dirty state for the current render-state snapshot. Cleared on
     * update() and populated lazily by isRowDirty() (or as a side effect of
     * getViewport, which iterates rows anyway).
     */
    private rowDirtyCache;
    /**
     * Per-row soft-wrap state for the current render-state snapshot. Same
     * lifecycle as rowDirtyCache; the two caches are filled in lockstep.
     */
    private rowWrapCache;
    /**
     * Bytes the terminal would have written back to a real PTY in response
     * to query sequences (DSR, XTVERSION, in-band size reports, ...).
     * Captured by the WRITE_PTY callback installed in the constructor and
     * drained by readResponse(). Each slot is one callback invocation, so
     * a single response sequence may span multiple slots.
     */
    private pendingResponses;
    /**
     * Per-table registry for callback trampolines. Keyed on the WASM
     * module's __indirect_function_table so that multiple Ghostty.load()
     * instances each get their own trampoline slots and routing map —
     * terminal handles are only unique within a single WASM instance, and
     * indices into one module's table are meaningless in another.
     */
    private static callbackRegistries;
    /**
     * Cached pointer to this terminal's registry. We only need it to
     * deregister cleanly in free() / cleanupOnConstructorFailure().
     */
    private callbackRegistry?;
    constructor(exports: GhosttyWasmExports, memory: WebAssembly.Memory, cols?: number, rows?: number, config?: GhosttyTerminalConfig);
    /**
     * Allocate an opaque handle through one of the new(allocator, *outHandle)
     * factory functions. Wraps the boilerplate of: alloc out-pointer, call
     * factory, check Result, read the handle, free out-pointer.
     *
     * If the factory call fails, frees any already-acquired terminal/render
     * resources so the caller-throwing flow doesn't leak across the partially
     * constructed object.
     */
    private allocOpaqueOrFail;
    /**
     * Apply user-supplied colors + palette overrides to the freshly-created
     * terminal via ghostty_terminal_set(COLOR_*).
     *
     * For the palette: the new C ABI takes a full 256-entry array, but coder's
     * config carries only the legacy 16 ANSI entries (each as a 0xRRGGBB int,
     * 0 meaning "use default"). To preserve indices ≥16 we read the existing
     * default palette first, overlay the non-zero entries from config, and
     * write the merged 768-byte buffer back.
     */
    private applyConfig;
    private setColorOption;
    /**
     * Release any resources that have been allocated by the constructor up to
     * this point. Called when a subsequent step fails so we don't leak handles
     * before the throw propagates.
     */
    private cleanupOnConstructorFailure;
    private rsGetU8;
    private rsGetU16;
    private rsGetU32;
    private rsGetRgb;
    private tGetU8;
    private tGetU32;
    get cols(): number;
    get rows(): number;
    write(data: string | Uint8Array): void;
    resize(cols: number, rows: number): void;
    /**
     * Set the maximum bytes of image data the terminal will retain across
     * all kitty graphics images. Zero disables kitty graphics entirely
     * (transmissions will be parsed and dropped). Set this BEFORE any
     * image-bearing data is written to the terminal — there's no
     * retroactive recovery of dropped images.
     *
     * Input is uint64_t* on the C side, so we use a u32-pair little-endian
     * write to keep the byte count exact even past 4GB (probably overkill
     * but free).
     */
    setKittyImageStorageLimit(bytes: number): void;
    /**
     * Get the kitty graphics storage handle for the active screen, or null
     * if storage is disabled or no images are stored. Cheap to call; returns
     * a borrowed pointer.
     */
    getKittyGraphics(): number | null;
    /**
     * Iterate placements in the active screen, yielding render-ready info
     * for each. The optional `onlyVisible` flag (default true) drops
     * placements that don't intersect the viewport — most renderers want
     * this. Use `false` if you need to track invalidated regions for
     * partial damage.
     *
     * Internally this uses the upstream placement iterator + the one-shot
     * placement_render_info call (fills 12 fields in one WASM crossing
     * instead of 5 separate getters).
     */
    iterPlacements(graphics: number, onlyVisible?: boolean): Generator<KittyPlacementInfo>;
    /**
     * Get the pixel data + metadata for an image by id. Returns null if the
     * image isn't stored or isn't in a format we can hand the renderer
     * directly (RGB / RGBA / GRAY / GRAY_ALPHA).
     *
     * The returned `data` is a borrowed view into WASM memory — copy before
     * the next vt_write if you need to retain. Most callers will turn this
     * into an ImageData / canvas immediately and discard the view.
     */
    getKittyImagePixels(graphics: number, imageId: number): KittyImagePixels | null;
    /**
     * Push the renderer's per-cell pixel size into the WASM terminal.
     *
     * The new C ABI doesn't expose a separate "set pixel size" call —
     * dimensions only flow through ghostty_terminal_resize, which takes
     * (cols, rows, cell_width_px, cell_height_px). We cache the cell pixel
     * dims on the instance so subsequent resize() calls keep the values
     * stable, and short-circuit when nothing has changed.
     *
     * The width/height arguments are PER-CELL CSS pixels — matches what
     * the renderer reports via getMetrics(). Coder's old setPixelSize
     * took TOTAL screen pixels (cell_width * cols, cell_height * rows);
     * we renamed to avoid silent value mis-passing.
     *
     * Affects in-band size reports (CSI 14/16/18 t) and kitty graphics
     * placement sizing. Until called, those query paths return zero.
     */
    setCellPixelSize(cellWidthPx: number, cellHeightPx: number): void;
    free(): void;
    /**
     * Update terminal colors at runtime. All color values are applied directly
     * (no sentinel — 0x000000 is valid black). Forces a full redraw on next render.
     */
    setColors(config: GhosttyTerminalConfig): void;
    /**
     * Write a GhosttyTerminalConfig into WASM memory at configPtr.
     *
     * Layout must match GhosttyTerminalConfig in src/terminal/c/terminal.zig:
     *   scrollback_limit: u32  (+0)
     *   fg_color:         u32  (+4)
     *   bg_color:         u32  (+8)
     *   cursor_color:     u32  (+12)
     *   palette:          [16]u32 (+16..+79)
     * Total: 80 bytes. Any struct change in Zig must be mirrored here.
     */
    private writeConfigToPtr;
    /**
     * Update render state from terminal.
     *
     * This syncs the RenderState with the current Terminal state.
     * The dirty state (full/partial/none) is stored in the WASM RenderState
     * and can be queried via isRowDirty(). When dirty==full, isRowDirty()
     * returns true for ALL rows.
     *
     * The WASM layer automatically detects screen switches (normal <-> alternate)
     * and returns FULL dirty state when switching screens (e.g., vim exit).
     *
     * Safe to call multiple times - dirty state persists until markClean().
     */
    update(): DirtyState;
    /**
     * Get cursor state from render state.
     * Calls update() first; safe to call repeatedly within a frame.
     */
    getCursor(): RenderStateCursor;
    /**
     * Get default fg/bg/cursor colors from render state.
     */
    getColors(): RenderStateColors;
    /**
     * Check if a specific row is dirty.
     *
     * Backed by a per-row cache populated lazily — first call after update()
     * walks the iterator once and reads the dirty flag for each row, then
     * subsequent calls are O(1). getViewport() also populates the cache as a
     * side effect so a typical "update → for-each-row isRowDirty → getViewport"
     * render loop only iterates rows once.
     */
    isRowDirty(y: number): boolean;
    /**
     * Check if a row is soft-wrapped (continues onto the next row).
     *
     * Same cache discipline as isRowDirty: lazy-populated on first call after
     * update(), or as a side effect of getViewport.
     */
    isRowWrapped(y: number): boolean;
    /**
     * Walk the row iterator once and capture per-row dirty + wrap flags.
     *
     * Calls update() first since callers (isRowDirty / isRowWrapped) typically
     * query right after a terminal write, before any explicit render-state
     * refresh has happened. Same idempotency guarantee as getCursor/getColors:
     * if no terminal change occurred since the last update, this is cheap.
     *
     * Reads ROW_DATA_DIRTY directly from the iterator, then ROW_DATA_RAW to
     * obtain the GhosttyRow (u64) needed to call ghostty_row_get(WRAP_*). The
     * row value is only valid for the current iterator position; we read it
     * inline before advancing.
     */
    private refreshRowMetaCache;
    /**
     * Mark render state as clean — clears both global and per-row dirty.
     *
     * Per the upstream contract, "setting one dirty state doesn't unset the
     * other." Global dirty is cleared via _set(OPTION_DIRTY, FALSE); per-row
     * dirty is cleared by walking the row iterator and calling _row_set on
     * each. Without the per-row pass, the next update() would still report
     * the old per-row flags as dirty even though the terminal hasn't changed.
     */
    markClean(): void;
    /**
     * Populate the cellPool from the current render state and return it.
     *
     * The new C ABI replaces coder's single ghostty_render_state_get_viewport()
     * buffer-fill with a row iterator + per-row cells iterator. We allocate
     * both iterators once at construction time and re-populate them per call:
     *
     *   _get(state, ROW_ITERATOR, &rowIter)
     *   while (row_iterator_next(rowIter)) {
     *     _row_get(rowIter, ROW_DATA_CELLS, &rowCells)
     *     while (row_cells_next(rowCells)) {
     *       _row_cells_get(rowCells, GRAPHEMES_LEN, &len)
     *       _row_cells_get(rowCells, GRAPHEMES_BUF, &codepoint)  // if len > 0
     *       _row_cells_get(rowCells, FG_COLOR/BG_COLOR, &rgb)    // INVALID_VALUE if unset
     *     }
     *   }
     *
     * This is intentionally minimal: we capture codepoint + fg/bg only.
     * Style flags, cell width (double-width), and hyperlink IDs are deferred
     * — they require parsing the GhosttyStyle sized struct and the per-cell
     * ghostty_cell_get(WIDE)/HAS_HYPERLINK paths. The cellPool fields keep
     * placeholder defaults (flags=0, width=1, hyperlink_id=0).
     *
     * Performance: ~3-4 WASM crossings per visible cell. For an 80x24 viewport
     * that's ~6k crossings per frame. Profile before optimizing — likely
     * candidates are _row_cells_get_multi for batched reads, or RAW + a
     * cached layout map for direct memory access.
     */
    getViewport(): GhosttyCell[];
    /**
     * Helper for the in/out pointer pattern used by ROW_ITERATOR / ROW_DATA_CELLS:
     * write a handle into a 4-byte slot, hand the slot to a populator, then
     * free the slot. The handle value itself is unchanged; the populator uses
     * it to find and rebind the iterator's internal data.
     */
    private populateHandle;
    /**
     * Reset every cell in the pool to "empty" so cells we don't visit during
     * iteration (e.g. iterator stopped early, or grid resized down) don't
     * carry stale values from a previous frame.
     */
    private zeroCellPool;
    /**
     * Get line - for compatibility, extracts from viewport.
     * Ensures render state is fresh by calling update().
     * Returns a COPY of the cells to avoid pool reference issues.
     */
    getLine(y: number): GhosttyCell[] | null;
    /** For compatibility with old API */
    isDirty(): boolean;
    /**
     * Check if a full redraw is needed (screen change, resize, etc.)
     * Note: This calls update() to ensure fresh state. Safe to call multiple times.
     */
    needsFullRedraw(): boolean;
    /** Mark render state as clean after rendering */
    clearDirty(): void;
    isAlternateScreen(): boolean;
    hasBracketedPaste(): boolean;
    hasFocusEvents(): boolean;
    hasMouseTracking(): boolean;
    /** Get dimensions - for compatibility */
    getDimensions(): {
        cols: number;
        rows: number;
    };
    /** Get number of scrollback lines (history, not including active screen) */
    getScrollbackLength(): number;
    /**
     * Get a line from the scrollback buffer.
     * @param offset 0 = oldest scrollback line, (scrollbackLength-1) = most
     *   recent scrollback line.
     *
     * Uses ghostty_terminal_grid_ref with POINT_TAG_HISTORY to address rows
     * outside the active viewport. The render-state row iterator only walks
     * the viewport, so scrollback access has to go through grid_ref.
     *
     * Cell content is currently codepoint-only; fg/bg colors, style flags,
     * and hyperlinks are deferred (defaults: 0 colors, flags=0, width=1).
     * The text-extraction tests that drove this commit only check codepoints.
     */
    getScrollbackLine(offset: number): GhosttyCell[] | null;
    /**
     * Get the hyperlink URI for a cell at the given position in the active
     * viewport. Returns null when no hyperlink is attached.
     */
    getHyperlinkUri(row: number, col: number): string | null;
    /**
     * Get the hyperlink URI for a cell in the scrollback buffer.
     */
    getScrollbackHyperlinkUri(offset: number, col: number): string | null;
    private readGridLine;
    /**
     * Decode a GhosttyStyleColor (16 bytes at colorPtr — tag@0:u32,
     * value@8:union) and write the resolved RGB into the cell's fg_*
     * or bg_* triple. Tag values: NONE=0 (leaves zeros so the renderer's
     * theme fallback kicks in), PALETTE=1 (looks up the terminal's
     * effective palette), RGB=2 (direct read).
     */
    private resolveStyleColor;
    private readHyperlinkUri;
    private allocPoint;
    private makeEmptyCell;
    /**
     * Check if there are pending responses from the terminal.
     *
     * NOTE: the upstream C ABI replaced the polling has_response/read_response
     * pair with a callback model: install one via
     * ghostty_terminal_set(GHOSTTY_TERMINAL_OPT_WRITE_PTY, fn) and the terminal
     * invokes it synchronously during vt_write() with response bytes. Until the
     * callback infrastructure is wired up on the JS side, we report "no
     * responses" so callers (e.g. demo/PTY echo) degrade gracefully.
     */
    hasResponse(): boolean;
    /**
     * Read pending responses from the terminal.
     */
    readResponse(): string | null;
    /**
     * Install the WRITE_PTY and SIZE trampoline callbacks.
     */
    private installCallbacks;
    /**
     * Query arbitrary terminal mode by number.
     * @param mode Mode number (e.g., 25 for cursor visibility, 2004 for bracketed paste)
     * @param isAnsi True for ANSI modes, false for DEC modes (default: false)
     */
    getMode(mode: number, isAnsi?: boolean): boolean;
    private invalidateCellCaches;
    private initCellPool;
    /**
     * Get all codepoints for a grapheme cluster at the given position.
     * For most cells this returns a single codepoint, but for complex scripts
     * (Hindi, emoji with ZWJ, etc.) it returns multiple codepoints.
     * @returns Array of codepoints, or null on error
     */
    getGrapheme(row: number, col: number): number[] | null;
    /**
     * Get a string representation of the grapheme at the given position.
     * This properly handles complex scripts like Hindi, emoji with ZWJ, etc.
     */
    getGraphemeString(row: number, col: number): string;
    /**
     * Get all codepoints for a grapheme cluster in the scrollback buffer.
     * @param offset Scrollback line offset (0 = oldest)
     * @param col Column index
     * @returns Array of codepoints, or null on error
     */
    getScrollbackGrapheme(offset: number, col: number): number[] | null;
    /**
     * Get a string representation of a grapheme in the scrollback buffer.
     */
    getScrollbackGraphemeString(offset: number, col: number): string;
}
//# sourceMappingURL=ghostty.d.ts.map