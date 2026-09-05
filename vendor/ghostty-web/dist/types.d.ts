/**
 * TypeScript type definitions for libghostty-vt WASM API
 * Based on include/ghostty/vt/*.h from Ghostty repository
 */
/**
 * SGR attribute tags - identifies the type of attribute
 * From include/ghostty/vt/sgr.h
 */
export declare enum SgrAttributeTag {
    UNSET = 0,
    UNKNOWN = 1,
    BOLD = 2,
    RESET_BOLD = 3,
    ITALIC = 4,
    RESET_ITALIC = 5,
    FAINT = 6,
    RESET_FAINT = 7,
    UNDERLINE = 8,
    RESET_UNDERLINE = 9,
    BLINK = 10,
    RESET_BLINK = 11,
    INVERSE = 12,
    RESET_INVERSE = 13,
    INVISIBLE = 14,
    RESET_INVISIBLE = 15,
    STRIKETHROUGH = 16,
    RESET_STRIKETHROUGH = 17,
    FG_8 = 18,// 8-color (0-7)
    FG_16 = 19,// 16-color (0-15)
    FG_256 = 20,// 256-color palette
    FG_RGB = 21,// RGB color
    FG_DEFAULT = 22,// Reset to default
    BG_8 = 23,// Background 8-color
    BG_16 = 24,// Background 16-color
    BG_256 = 25,// Background 256-color
    BG_RGB = 26,// Background RGB
    BG_DEFAULT = 27,// Reset background
    UNDERLINE_COLOR_8 = 28,
    UNDERLINE_COLOR_16 = 29,
    UNDERLINE_COLOR_256 = 30,
    UNDERLINE_COLOR_RGB = 31,
    UNDERLINE_COLOR_DEFAULT = 32
}
export interface RGBColor {
    r: number;
    g: number;
    b: number;
}
export type SgrAttribute = {
    tag: SgrAttributeTag.BOLD;
} | {
    tag: SgrAttributeTag.RESET_BOLD;
} | {
    tag: SgrAttributeTag.ITALIC;
} | {
    tag: SgrAttributeTag.RESET_ITALIC;
} | {
    tag: SgrAttributeTag.FAINT;
} | {
    tag: SgrAttributeTag.RESET_FAINT;
} | {
    tag: SgrAttributeTag.UNDERLINE;
} | {
    tag: SgrAttributeTag.RESET_UNDERLINE;
} | {
    tag: SgrAttributeTag.BLINK;
} | {
    tag: SgrAttributeTag.RESET_BLINK;
} | {
    tag: SgrAttributeTag.INVERSE;
} | {
    tag: SgrAttributeTag.RESET_INVERSE;
} | {
    tag: SgrAttributeTag.INVISIBLE;
} | {
    tag: SgrAttributeTag.RESET_INVISIBLE;
} | {
    tag: SgrAttributeTag.STRIKETHROUGH;
} | {
    tag: SgrAttributeTag.RESET_STRIKETHROUGH;
} | {
    tag: SgrAttributeTag.FG_8;
    color: number;
} | {
    tag: SgrAttributeTag.FG_16;
    color: number;
} | {
    tag: SgrAttributeTag.FG_256;
    color: number;
} | {
    tag: SgrAttributeTag.FG_RGB;
    color: RGBColor;
} | {
    tag: SgrAttributeTag.FG_DEFAULT;
} | {
    tag: SgrAttributeTag.BG_8;
    color: number;
} | {
    tag: SgrAttributeTag.BG_16;
    color: number;
} | {
    tag: SgrAttributeTag.BG_256;
    color: number;
} | {
    tag: SgrAttributeTag.BG_RGB;
    color: RGBColor;
} | {
    tag: SgrAttributeTag.BG_DEFAULT;
} | {
    tag: SgrAttributeTag.UNDERLINE_COLOR_RGB;
    color: RGBColor;
} | {
    tag: SgrAttributeTag.UNDERLINE_COLOR_DEFAULT;
} | {
    tag: SgrAttributeTag.UNKNOWN;
    params: number[];
};
/**
 * Kitty keyboard protocol flags
 * From include/ghostty/vt/key/encoder.h
 */
export declare enum KittyKeyFlags {
    DISABLED = 0,
    DISAMBIGUATE = 1,// Disambiguate escape codes
    REPORT_EVENTS = 2,// Report press and release
    REPORT_ALTERNATES = 4,// Report alternate key codes
    REPORT_ALL = 8,// Report all events
    REPORT_ASSOCIATED = 16,// Report associated text
    ALL = 31
}
/**
 * Key encoder options
 */
export declare enum KeyEncoderOption {
    CURSOR_KEY_APPLICATION = 0,// DEC mode 1
    KEYPAD_KEY_APPLICATION = 1,// DEC mode 66
    IGNORE_KEYPAD_WITH_NUMLOCK = 2,// DEC mode 1035
    ALT_ESC_PREFIX = 3,// DEC mode 1036
    MODIFY_OTHER_KEYS_STATE_2 = 4,// xterm modifyOtherKeys
    KITTY_KEYBOARD_FLAGS = 5
}
/**
 * Key action
 */
export declare enum KeyAction {
    RELEASE = 0,
    PRESS = 1,
    REPEAT = 2
}
/**
 * Physical key codes matching Ghostty's internal Key enum.
 * These values are used by Ghostty's key encoder to produce correct escape sequences.
 * Reference: ghostty/src/input/key.zig
 */
export declare enum Key {
    UNIDENTIFIED = 0,
    GRAVE = 1,// ` and ~
    BACKSLASH = 2,// \ and |
    BRACKET_LEFT = 3,// [ and {
    BRACKET_RIGHT = 4,// ] and }
    COMMA = 5,// , and <
    ZERO = 6,
    ONE = 7,
    TWO = 8,
    THREE = 9,
    FOUR = 10,
    FIVE = 11,
    SIX = 12,
    SEVEN = 13,
    EIGHT = 14,
    NINE = 15,
    EQUAL = 16,// = and +
    INTL_BACKSLASH = 17,
    INTL_RO = 18,
    INTL_YEN = 19,
    A = 20,
    B = 21,
    C = 22,
    D = 23,
    E = 24,
    F = 25,
    G = 26,
    H = 27,
    I = 28,
    J = 29,
    K = 30,
    L = 31,
    M = 32,
    N = 33,
    O = 34,
    P = 35,
    Q = 36,
    R = 37,
    S = 38,
    T = 39,
    U = 40,
    V = 41,
    W = 42,
    X = 43,
    Y = 44,
    Z = 45,
    MINUS = 46,// - and _
    PERIOD = 47,// . and >
    QUOTE = 48,// ' and "
    SEMICOLON = 49,// ; and :
    SLASH = 50,// / and ?
    ALT_LEFT = 51,
    ALT_RIGHT = 52,
    BACKSPACE = 53,
    CAPS_LOCK = 54,
    CONTEXT_MENU = 55,
    CONTROL_LEFT = 56,
    CONTROL_RIGHT = 57,
    ENTER = 58,
    META_LEFT = 59,
    META_RIGHT = 60,
    SHIFT_LEFT = 61,
    SHIFT_RIGHT = 62,
    SPACE = 63,
    TAB = 64,
    CONVERT = 65,
    KANA_MODE = 66,
    NON_CONVERT = 67,
    DELETE = 68,
    END = 69,
    HELP = 70,
    HOME = 71,
    INSERT = 72,
    PAGE_DOWN = 73,
    PAGE_UP = 74,
    DOWN = 75,
    LEFT = 76,
    RIGHT = 77,
    UP = 78,
    NUM_LOCK = 79,
    KP_0 = 80,
    KP_1 = 81,
    KP_2 = 82,
    KP_3 = 83,
    KP_4 = 84,
    KP_5 = 85,
    KP_6 = 86,
    KP_7 = 87,
    KP_8 = 88,
    KP_9 = 89,
    KP_PLUS = 90,// Keypad +
    KP_BACKSPACE = 91,
    KP_CLEAR = 92,
    KP_CLEAR_ENTRY = 93,
    KP_COMMA = 94,
    KP_PERIOD = 95,// Keypad .
    KP_DIVIDE = 96,// Keypad /
    KP_ENTER = 97,// Keypad Enter
    KP_EQUAL = 98,
    KP_MEMORY_ADD = 99,
    KP_MEMORY_CLEAR = 100,
    KP_MEMORY_RECALL = 101,
    KP_MEMORY_STORE = 102,
    KP_MEMORY_SUBTRACT = 103,
    KP_MULTIPLY = 104,// Keypad *
    KP_PAREN_LEFT = 105,
    KP_PAREN_RIGHT = 106,
    KP_MINUS = 107,// Keypad -
    KP_SEPARATOR = 108,
    NUMPAD_UP = 109,
    NUMPAD_DOWN = 110,
    NUMPAD_RIGHT = 111,
    NUMPAD_LEFT = 112,
    NUMPAD_BEGIN = 113,
    NUMPAD_HOME = 114,
    NUMPAD_END = 115,
    NUMPAD_INSERT = 116,
    NUMPAD_DELETE = 117,
    NUMPAD_PAGE_UP = 118,
    NUMPAD_PAGE_DOWN = 119,
    ESCAPE = 120,
    F1 = 121,
    F2 = 122,
    F3 = 123,
    F4 = 124,
    F5 = 125,
    F6 = 126,
    F7 = 127,
    F8 = 128,
    F9 = 129,
    F10 = 130,
    F11 = 131,
    F12 = 132,
    F13 = 133,
    F14 = 134,
    F15 = 135,
    F16 = 136,
    F17 = 137,
    F18 = 138,
    F19 = 139,
    F20 = 140,
    F21 = 141,
    F22 = 142,
    F23 = 143,
    F24 = 144,
    F25 = 145,
    FN_LOCK = 146,
    PRINT_SCREEN = 147,
    SCROLL_LOCK = 148,
    PAUSE = 149,
    BROWSER_BACK = 150,
    BROWSER_FAVORITES = 151,
    BROWSER_FORWARD = 152,
    BROWSER_HOME = 153,
    BROWSER_REFRESH = 154,
    BROWSER_SEARCH = 155,
    BROWSER_STOP = 156,
    EJECT = 157,
    LAUNCH_APP_1 = 158,
    LAUNCH_APP_2 = 159,
    LAUNCH_MAIL = 160,
    MEDIA_PLAY_PAUSE = 161,
    MEDIA_SELECT = 162,
    MEDIA_STOP = 163,
    MEDIA_TRACK_NEXT = 164,
    MEDIA_TRACK_PREVIOUS = 165,
    POWER = 166,
    SLEEP = 167,
    AUDIO_VOLUME_DOWN = 168,
    AUDIO_VOLUME_MUTE = 169,
    AUDIO_VOLUME_UP = 170,
    WAKE_UP = 171,
    COPY = 172,
    CUT = 173,
    PASTE = 174
}
/**
 * Modifier keys
 */
export declare enum Mods {
    NONE = 0,
    SHIFT = 1,
    CTRL = 2,
    ALT = 4,
    SUPER = 8,// Windows/Command key
    CAPSLOCK = 16,
    NUMLOCK = 32
}
/**
 * Key event structure
 */
export interface KeyEvent {
    action: KeyAction;
    key: Key;
    mods: Mods;
    consumedMods?: Mods;
    composing?: boolean;
    utf8?: string;
    unshiftedCodepoint?: number;
}
/**
 * Interface for libghostty-vt WASM exports
 */
export interface GhosttyWasmExports extends WebAssembly.Exports {
    memory: WebAssembly.Memory;
    ghostty_wasm_alloc_opaque(): number;
    ghostty_wasm_free_opaque(ptr: number): void;
    ghostty_wasm_alloc_u8_array(len: number): number;
    ghostty_wasm_free_u8_array(ptr: number, len: number): void;
    ghostty_wasm_alloc_u16_array(len: number): number;
    ghostty_wasm_free_u16_array(ptr: number, len: number): void;
    ghostty_wasm_alloc_u8(): number;
    ghostty_wasm_free_u8(ptr: number): void;
    ghostty_wasm_alloc_usize(): number;
    ghostty_wasm_free_usize(ptr: number): void;
    ghostty_sgr_new(allocator: number, parserPtrPtr: number): number;
    ghostty_sgr_free(parser: number): void;
    ghostty_sgr_reset(parser: number): void;
    ghostty_sgr_set_params(parser: number, paramsPtr: number, subsPtr: number, paramsLen: number): number;
    ghostty_sgr_next(parser: number, attrPtr: number): boolean;
    ghostty_sgr_attribute_tag(attrPtr: number): number;
    ghostty_sgr_attribute_value(attrPtr: number, tagPtr: number): number;
    ghostty_wasm_alloc_sgr_attribute(): number;
    ghostty_wasm_free_sgr_attribute(ptr: number): void;
    ghostty_key_encoder_new(allocator: number, encoderPtrPtr: number): number;
    ghostty_key_encoder_free(encoder: number): void;
    ghostty_key_encoder_setopt(encoder: number, option: number, valuePtr: number): number;
    ghostty_key_encoder_encode(encoder: number, eventPtr: number, bufPtr: number, bufLen: number, writtenPtr: number): number;
    ghostty_key_event_new(allocator: number, eventPtrPtr: number): number;
    ghostty_key_event_free(event: number): void;
    ghostty_key_event_set_action(event: number, action: number): void;
    ghostty_key_event_set_key(event: number, key: number): void;
    ghostty_key_event_set_mods(event: number, mods: number): void;
    ghostty_key_event_set_utf8(event: number, ptr: number, len: number): void;
    ghostty_terminal_new(allocatorPtr: number, terminalPtrPtr: number, optionsPtr: number): number;
    ghostty_terminal_free(terminal: TerminalHandle): void;
    ghostty_terminal_resize(terminal: TerminalHandle, cols: number, rows: number, cellWidthPx: number, cellHeightPx: number): number;
    ghostty_terminal_vt_write(terminal: TerminalHandle, dataPtr: number, dataLen: number): void;
    ghostty_terminal_set_colors(terminal: TerminalHandle, configPtr: number): void;
    ghostty_render_state_new(allocatorPtr: number, statePtrPtr: number): number;
    ghostty_render_state_free(state: number): void;
    ghostty_render_state_update(state: number, terminal: TerminalHandle): number;
    ghostty_render_state_get(state: number, key: number, outPtr: number): number;
    ghostty_render_state_get_multi(state: number, count: number, keysPtr: number, valuesPtr: number, outWrittenPtr: number): number;
    ghostty_render_state_set(state: number, option: number, valuePtr: number): number;
    ghostty_render_state_colors_get(state: number, outColorsPtr: number): number;
    ghostty_render_state_row_iterator_new(allocatorPtr: number, outIterPtrPtr: number): number;
    ghostty_render_state_row_iterator_free(iter: number): void;
    ghostty_render_state_row_iterator_next(iter: number): boolean;
    ghostty_render_state_row_get(iter: number, key: number, outPtr: number): number;
    ghostty_render_state_row_set(iter: number, option: number, valuePtr: number): number;
    ghostty_render_state_row_cells_new(allocatorPtr: number, outCellsPtrPtr: number): number;
    ghostty_render_state_row_cells_free(cells: number): void;
    ghostty_render_state_row_cells_next(cells: number): boolean;
    ghostty_render_state_row_cells_select(cells: number, col: number): number;
    ghostty_render_state_row_cells_get(cells: number, key: number, outPtr: number): number;
    ghostty_render_state_row_cells_get_multi(cells: number, count: number, keysPtr: number, valuesPtr: number, outWrittenPtr: number): number;
    ghostty_cell_get(cell: bigint, key: number, outPtr: number): number;
    ghostty_row_get(row: bigint, key: number, outPtr: number): number;
    ghostty_terminal_grid_ref(terminal: TerminalHandle, pointPtr: number, outRefPtr: number): number;
    ghostty_grid_ref_cell(refPtr: number, outCellPtr: number): number;
    ghostty_grid_ref_row(refPtr: number, outRowPtr: number): number;
    ghostty_grid_ref_graphemes(refPtr: number, bufPtr: number, bufLen: number, outLenPtr: number): number;
    ghostty_grid_ref_hyperlink_uri(refPtr: number, bufPtr: number, bufLen: number, outLenPtr: number): number;
    ghostty_grid_ref_style(refPtr: number, outStylePtr: number): number;
    ghostty_kitty_graphics_get(graphics: number, key: number, outPtr: number): number;
    ghostty_kitty_graphics_image(graphics: number, imageId: number): number;
    ghostty_kitty_graphics_image_get(image: number, key: number, outPtr: number): number;
    ghostty_kitty_graphics_image_get_multi(image: number, count: number, keysPtr: number, valuesPtr: number, outWrittenPtr: number): number;
    ghostty_kitty_graphics_placement_iterator_new(allocatorPtr: number, outIterPtrPtr: number): number;
    ghostty_kitty_graphics_placement_iterator_free(iter: number): void;
    ghostty_kitty_graphics_placement_iterator_set(iter: number, option: number, valuePtr: number): number;
    ghostty_kitty_graphics_placement_next(iter: number): boolean;
    ghostty_kitty_graphics_placement_get(iter: number, key: number, outPtr: number): number;
    ghostty_kitty_graphics_placement_get_multi(iter: number, count: number, keysPtr: number, valuesPtr: number, outWrittenPtr: number): number;
    ghostty_kitty_graphics_placement_rect(iter: number, image: number, terminal: TerminalHandle, outSelectionPtr: number): number;
    ghostty_kitty_graphics_placement_pixel_size(iter: number, image: number, terminal: TerminalHandle, outWidthPtr: number, outHeightPtr: number): number;
    ghostty_kitty_graphics_placement_grid_size(iter: number, image: number, terminal: TerminalHandle, outColsPtr: number, outRowsPtr: number): number;
    ghostty_kitty_graphics_placement_viewport_pos(iter: number, image: number, terminal: TerminalHandle, outColPtr: number, outRowPtr: number): number;
    ghostty_kitty_graphics_placement_source_rect(iter: number, image: number, outX: number, outY: number, outW: number, outH: number): number;
    ghostty_kitty_graphics_placement_render_info(iter: number, image: number, terminal: TerminalHandle, outInfoPtr: number): number;
    ghostty_terminal_get(terminal: TerminalHandle, key: number, outPtr: number): number;
    ghostty_terminal_get_multi(terminal: TerminalHandle, count: number, keysPtr: number, valuesPtr: number, outWrittenPtr: number): number;
    ghostty_terminal_set(terminal: TerminalHandle, option: number, valuePtr: number): number;
    ghostty_sys_set(option: number, valuePtr: number): number;
    ghostty_alloc(allocatorPtr: number, len: number): number;
    ghostty_free(allocatorPtr: number, ptr: number, len: number): void;
    ghostty_terminal_mode_get(terminal: TerminalHandle, mode: number, outBoolPtr: number): number;
    ghostty_terminal_mode_set(terminal: TerminalHandle, mode: number, value: boolean): number;
}
/**
 * Dirty state from RenderState. Mirrors GhosttyRenderStateDirty.
 */
export declare enum DirtyState {
    NONE = 0,
    PARTIAL = 1,
    FULL = 2
}
/**
 * Keys for ghostty_render_state_get(). Mirrors GhosttyRenderStateData.
 */
export declare enum RenderStateData {
    COLS = 1,
    ROWS = 2,
    DIRTY = 3,
    ROW_ITERATOR = 4,
    COLOR_BACKGROUND = 5,
    COLOR_FOREGROUND = 6,
    COLOR_CURSOR = 7,
    COLOR_CURSOR_HAS_VALUE = 8,
    COLOR_PALETTE = 9,
    CURSOR_VISUAL_STYLE = 10,
    CURSOR_VISIBLE = 11,
    CURSOR_BLINKING = 12,
    CURSOR_PASSWORD_INPUT = 13,
    CURSOR_VIEWPORT_HAS_VALUE = 14,
    CURSOR_VIEWPORT_X = 15,
    CURSOR_VIEWPORT_Y = 16,
    CURSOR_VIEWPORT_WIDE_TAIL = 17
}
/**
 * Options for ghostty_render_state_set(). Mirrors GhosttyRenderStateOption.
 */
export declare enum RenderStateOption {
    DIRTY = 0
}
/**
 * Visual cursor style. Mirrors GhosttyRenderStateCursorVisualStyle.
 */
export declare enum CursorVisualStyle {
    BAR = 0,
    BLOCK = 1,
    UNDERLINE = 2,
    BLOCK_HOLLOW = 3
}
/**
 * Keys for ghostty_terminal_get(). Mirrors GhosttyTerminalData.
 * Only entries actually used by the TS layer are listed here; the upstream
 * enum has more (TITLE, PWD, SCROLLBAR, KITTY_KEYBOARD_FLAGS, palettes, ...).
 */
export declare enum TerminalData {
    COLS = 1,
    ROWS = 2,
    CURSOR_X = 3,
    CURSOR_Y = 4,
    CURSOR_PENDING_WRAP = 5,
    ACTIVE_SCREEN = 6,
    CURSOR_VISIBLE = 7,
    KITTY_KEYBOARD_FLAGS = 8,
    SCROLLBAR = 9,
    CURSOR_STYLE = 10,
    MOUSE_TRACKING = 11,
    TITLE = 12,
    PWD = 13,
    TOTAL_ROWS = 14,
    SCROLLBACK_ROWS = 15,
    WIDTH_PX = 16,
    HEIGHT_PX = 17,
    COLOR_FOREGROUND = 18,
    COLOR_BACKGROUND = 19,
    COLOR_CURSOR = 20,
    COLOR_PALETTE = 21,
    COLOR_FOREGROUND_DEFAULT = 22,
    COLOR_BACKGROUND_DEFAULT = 23,
    COLOR_CURSOR_DEFAULT = 24,
    COLOR_PALETTE_DEFAULT = 25,
    KITTY_IMAGE_STORAGE_LIMIT = 26,
    KITTY_GRAPHICS = 30
}
/**
 * Options for ghostty_terminal_set(). Mirrors GhosttyTerminalOption.
 * Only the entries the TS layer touches are listed; the upstream enum has
 * more (callbacks for BELL/TITLE_CHANGED/etc., kitty-image limits, ...).
 */
export declare enum TerminalOption {
    USERDATA = 0,
    WRITE_PTY = 1,
    BELL = 2,
    ENQUIRY = 3,
    XTVERSION = 4,
    TITLE_CHANGED = 5,
    SIZE = 6,
    COLOR_FOREGROUND = 11,
    COLOR_BACKGROUND = 12,
    COLOR_CURSOR = 13,
    COLOR_PALETTE = 14,
    KITTY_IMAGE_STORAGE_LIMIT = 15
}
/**
 * Options for ghostty_sys_set(). Mirrors GhosttySysOption.
 * Process-global / per-WASM-instance settings.
 */
export declare enum SysOption {
    USERDATA = 0,
    DECODE_PNG = 1,
    LOG = 2
}
/**
 * Keys for ghostty_kitty_graphics_get(). Mirrors GhosttyKittyGraphicsData.
 */
export declare enum KittyGraphicsData {
    PLACEMENT_ITERATOR = 1
}
/**
 * Keys for ghostty_kitty_graphics_placement_get(). Mirrors
 * GhosttyKittyGraphicsPlacementData. All values are u32 except Z (i32).
 */
export declare enum KittyGraphicsPlacementData {
    IMAGE_ID = 1,
    PLACEMENT_ID = 2,
    IS_VIRTUAL = 3,
    X_OFFSET = 4,
    Y_OFFSET = 5,
    SOURCE_X = 6,
    SOURCE_Y = 7,
    SOURCE_WIDTH = 8,
    SOURCE_HEIGHT = 9,
    COLUMNS = 10,
    ROWS = 11,
    Z = 12
}
/**
 * Keys for ghostty_kitty_graphics_image_get(). Mirrors GhosttyKittyGraphicsImageData.
 */
export declare enum KittyGraphicsImageData {
    ID = 1,
    NUMBER = 2,
    WIDTH = 3,
    HEIGHT = 4,
    FORMAT = 5,
    COMPRESSION = 6,
    DATA_PTR = 7,
    DATA_LEN = 8
}
/**
 * Z-layer filter for the placement iterator. Mirrors GhosttyKittyPlacementLayer.
 */
export declare enum KittyGraphicsPlacementLayer {
    ALL = 0,
    BELOW_BG = 1,
    BELOW_TEXT = 2,
    ABOVE_TEXT = 3
}
/**
 * Settable options on the placement iterator. Mirrors
 * GhosttyKittyGraphicsPlacementIteratorOption.
 */
export declare enum KittyGraphicsPlacementIteratorOption {
    LAYER = 0
}
/**
 * Pixel format of a Kitty graphics image. Mirrors GhosttyKittyImageFormat.
 *   RGB:        24-bit, 3 bytes/px
 *   RGBA:       32-bit, 4 bytes/px (the canvas-friendly path)
 *   PNG:        compressed; needs a JS-side decoder hooked up via
 *               ghostty_sys_set(DECODE_PNG, fn)
 *   GRAY_ALPHA: 16-bit, 2 bytes/px
 *   GRAY:       8-bit, 1 byte/px
 */
export declare enum KittyImageFormat {
    RGB = 0,
    RGBA = 1,
    PNG = 2,
    GRAY_ALPHA = 3,
    GRAY = 4
}
/**
 * Compression of a Kitty graphics image. Mirrors GhosttyKittyImageCompression.
 */
export declare enum KittyImageCompression {
    NONE = 0,
    ZLIB_DEFLATE = 1
}
/**
 * Parsed GhosttyKittyGraphicsPlacementRenderInfo — everything the renderer
 * needs about a single placement to composite it on the canvas.
 *
 * Wire layout on wasm32 (48 bytes, extern struct, 4-byte aligned):
 *   size:               u32 @ 0   (sized-struct discriminator; we just write 48)
 *   pixel_width:        u32 @ 4
 *   pixel_height:       u32 @ 8
 *   grid_cols:          u32 @ 12
 *   grid_rows:          u32 @ 16
 *   viewport_col:       i32 @ 20
 *   viewport_row:       i32 @ 24
 *   viewport_visible:   bool @ 28 (1 byte + 3 bytes padding to next u32)
 *   source_x:           u32 @ 32
 *   source_y:           u32 @ 36
 *   source_width:       u32 @ 40
 *   source_height:      u32 @ 44
 */
export interface KittyPlacementInfo {
    imageId: number;
    /** Destination size on the canvas, in pixels. */
    pixelWidth: number;
    pixelHeight: number;
    /** Destination size on the grid, in cells. */
    gridCols: number;
    gridRows: number;
    /** Top-left in viewport-relative cells. Negative when scrolled partway off the top. */
    viewportCol: number;
    viewportRow: number;
    /** Whether any part of the placement intersects the visible viewport. */
    viewportVisible: boolean;
    /** Source rect within the image, in pixels (already clamped to image bounds). */
    sourceX: number;
    sourceY: number;
    sourceWidth: number;
    sourceHeight: number;
    /**
     * Virtual placements have no fixed viewport position; their image is
     * drawn into U+10EEEE placeholder cells written to the grid by the
     * application. The renderer picks them up by image_id rather than
     * iterating through them for direct compositing.
     */
    isVirtual: boolean;
}
/** Size in bytes of GhosttyKittyGraphicsPlacementRenderInfo on wasm32. */
export declare const KITTY_PLACEMENT_RENDER_INFO_SIZE = 48;
/**
 * Image bytes + metadata returned by GhosttyTerminal.getKittyImageRgba.
 * `data` is a *view* into WASM memory and is invalidated by the next
 * mutating terminal call — copy out before vt_write if you need to retain.
 */
export interface KittyImagePixels {
    width: number;
    height: number;
    format: KittyImageFormat;
    /** Borrowed view into WASM memory; copy before vt_write to retain. */
    data: Uint8Array;
}
/**
 * Active screen identifier. Mirrors GhosttyTerminalScreen.
 * Returned as the value for TerminalData.ACTIVE_SCREEN.
 */
export declare enum TerminalScreen {
    PRIMARY = 0,
    ALTERNATE = 1
}
/**
 * Keys for ghostty_render_state_row_get(). Mirrors GhosttyRenderStateRowData.
 */
export declare enum RenderStateRowData {
    DIRTY = 1,
    RAW = 2,
    CELLS = 3
}
/**
 * Options for ghostty_render_state_row_set(). Mirrors GhosttyRenderStateRowOption.
 */
export declare enum RenderStateRowOption {
    DIRTY = 0
}
/**
 * Keys for ghostty_render_state_row_cells_get(). Mirrors
 * GhosttyRenderStateRowCellsData.
 */
export declare enum RowCellsData {
    RAW = 1,
    STYLE = 2,
    GRAPHEMES_LEN = 3,
    GRAPHEMES_BUF = 4,
    BG_COLOR = 5,
    FG_COLOR = 6
}
/**
 * Keys for ghostty_row_get(). Mirrors GhosttyRowData. Used with the raw
 * GhosttyRow value obtained via _render_state_row_get(iter, RAW, &row).
 */
export declare enum RowData {
    WRAP = 1,
    WRAP_CONTINUATION = 2,
    GRAPHEME = 3,
    STYLED = 4,
    HYPERLINK = 5
}
/**
 * Tag values for GhosttyPoint. Mirrors GhosttyPointTag. The tag selects
 * which coordinate space y is interpreted in.
 */
export declare enum PointTag {
    ACTIVE = 0,
    VIEWPORT = 1,
    SCREEN = 2,
    HISTORY = 3
}
/**
 * Keys for ghostty_cell_get(). Mirrors GhosttyCellData. Used with the
 * raw GhosttyCell value obtained via grid_ref_cell or row_cells_get(RAW).
 */
export declare enum CellData {
    CODEPOINT = 1,
    CONTENT_TAG = 2,
    WIDE = 3,
    HAS_TEXT = 4,
    HAS_STYLING = 5,
    STYLE_ID = 6,
    HAS_HYPERLINK = 7,
    PROTECTED = 8,
    SEMANTIC_CONTENT = 9,
    COLOR_PALETTE = 10,
    COLOR_RGB = 11
}
/**
 * Cell width classification. Mirrors GhosttyCellWide.
 *   NARROW: single-column cell (most ASCII, BMP)
 *   WIDE: leading half of a double-width cell (CJK, most emoji)
 *   SPACER_TAIL: trailing half of a wide cell — placeholder, no glyph
 *   SPACER_HEAD: leading placeholder when a wide cell would have crossed
 *     the right margin and got pushed to the next row
 */
export declare enum CellWide {
    NARROW = 0,
    WIDE = 1,
    SPACER_TAIL = 2,
    SPACER_HEAD = 3
}
/**
 * Pack a terminal mode number + ANSI flag into the u16 wire format used by
 * ghostty_terminal_mode_get/_set. Bits 0–14 hold the value (u15), bit 15
 * is set for ANSI modes (cleared for DEC private modes).
 */
export declare function packMode(mode: number, isAnsi: boolean): number;
/**
 * Cursor state from RenderState (8 bytes packed)
 * Layout: x(u16) + y(u16) + viewport_x(i16) + viewport_y(i16) + visible(bool) + blinking(bool) + style(u8) + _pad(u8)
 */
export interface RenderStateCursor {
    x: number;
    y: number;
    viewportX: number;
    viewportY: number;
    visible: boolean;
    blinking: boolean;
    style: 'block' | 'underline' | 'bar' | undefined;
}
/**
 * Colors from RenderState (12 bytes packed)
 */
export interface RenderStateColors {
    background: RGB;
    foreground: RGB;
    cursor: RGB | null;
}
/**
 * Size of cursor struct in WASM (8 bytes)
 */
export declare const CURSOR_STRUCT_SIZE = 8;
/**
 * Size of colors struct in WASM (12 bytes)
 */
export declare const COLORS_STRUCT_SIZE = 12;
/**
 * Terminal theme/config payload used by the legacy color-configuration helper.
 * All color values use 0xRRGGBB format. A value of 0 means "use default".
 */
export interface GhosttyTerminalConfig {
    scrollbackLimit?: number;
    fgColor?: number;
    bgColor?: number;
    cursorColor?: number;
    palette?: number[];
}
/**
 * Size of GhosttyTerminalConfig struct in WASM memory (bytes).
 * Layout: scrollback_limit(u32) + fg_color(u32) + bg_color(u32) + cursor_color(u32) + palette[16](u32*16)
 * Total: 4 + 4 + 4 + 4 + 64 = 80 bytes
 */
export declare const GHOSTTY_CONFIG_SIZE = 80;
/**
 * Opaque terminal pointer (WASM memory address)
 */
export type TerminalHandle = number;
/**
 * Cell structure matching ghostty_cell_t in C (16 bytes)
 */
export interface GhosttyCell {
    codepoint: number;
    fg_r: number;
    fg_g: number;
    fg_b: number;
    bg_r: number;
    bg_g: number;
    bg_b: number;
    fgIsDefault: boolean;
    bgIsDefault: boolean;
    flags: number;
    width: number;
    hyperlink_id: number;
    grapheme_len: number;
}
/**
 * RGB color
 */
export interface RGB {
    r: number;
    g: number;
    b: number;
}
/**
 * Cell style flags (bitfield)
 */
export declare enum CellFlags {
    BOLD = 1,
    ITALIC = 2,
    UNDERLINE = 4,
    STRIKETHROUGH = 8,
    INVERSE = 16,
    INVISIBLE = 32,
    BLINK = 64,
    FAINT = 128
}
/**
 * Cursor position and visibility
 */
export interface Cursor {
    x: number;
    y: number;
    visible: boolean;
}
/**
 * Legacy packed terminal configuration shape.
 */
export interface TerminalConfig {
    scrollback_limit: number;
    fg_color: RGB;
    bg_color: RGB;
}
/**
 * Represents a coordinate in the terminal buffer
 */
export interface IBufferCellPosition {
    x: number;
    y: number;
}
/**
 * Represents a range in the terminal buffer
 * Can span multiple lines for wrapped links
 */
export interface IBufferRange {
    start: IBufferCellPosition;
    end: IBufferCellPosition;
}
/**
 * Represents a detected link in the terminal
 */
export interface ILink {
    /** The URL or text of the link */
    text: string;
    /** The range of the link in the buffer (may span multiple lines) */
    range: IBufferRange;
    /** Called when the link is activated (clicked with modifier) */
    activate(event: MouseEvent): void;
    /** Optional: called when mouse enters/leaves the link */
    hover?(isHovered: boolean): void;
    /** Optional: called to clean up resources */
    dispose?(): void;
}
/**
 * Provides link detection for a specific type of link
 * Examples: OSC 8 hyperlinks, URL regex detection
 */
export interface ILinkProvider {
    /**
     * Provide links for a given row
     * @param y Absolute row in buffer (0-based)
     * @param callback Called with detected links (or undefined if none)
     */
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
    /** Optional: called when terminal is disposed */
    dispose?(): void;
}
/**
 * Simplified buffer line interface for link providers
 */
export interface IBufferLine {
    /** Number of cells in this line */
    length: number;
    /** Get cell at position */
    getCell(x: number): IBufferCell;
    /** Get text content of the line */
    translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}
/**
 * Simplified buffer cell interface for link providers
 */
export interface IBufferCell {
    /** Get the character codepoint */
    getCodepoint(): number;
    /** Get the hyperlink ID (0 = no link) */
    getHyperlinkId(): number;
    /** Get the width of the character (1 or 2 for wide chars) */
    getWidth(): number;
    /** Check if cell has specific flags */
    isBold(): boolean;
    isItalic(): boolean;
    isDim(): boolean;
}
/**
 * Simplified terminal buffer interface for link providers
 */
export interface IBuffer {
    /** Number of rows in the buffer (viewport + scrollback) */
    length: number;
    /** Get line at absolute buffer position */
    getLine(y: number): IBufferLine;
}
/**
 * Terminal buffer manager (active vs alternate screen)
 */
export interface IBufferManager {
    /** Currently active buffer */
    active: IBuffer;
    /** Normal screen buffer */
    normal: IBuffer;
    /** Alternate screen buffer (for fullscreen apps) */
    alternate: IBuffer;
}
/**
 * Event system interface (xterm.js compatible)
 */
export type IEvent<T> = (listener: (data: T) => void) => IDisposable;
export interface IDisposable {
    dispose(): void;
}
/**
 * Event emitter for custom events
 */
export declare class EventEmitter<T> {
    private listeners;
    /** Subscribe to events */
    readonly event: IEvent<T>;
    /** Emit an event to all listeners */
    fire(data: T): void;
    /** Remove all listeners */
    dispose(): void;
}
/**
 * Terminal mode identifiers
 *
 * ANSI modes (use with is_ansi = true):
 * - INSERT = 4
 *
 * DEC modes (use with is_ansi = false):
 * - CURSOR_VISIBLE = 25
 * - MOUSE_TRACKING_NORMAL = 1000
 * - MOUSE_TRACKING_BUTTON = 1002
 * - MOUSE_TRACKING_ANY = 1003
 * - FOCUS_EVENTS = 1004
 * - ALT_SCREEN = 1047
 * - ALT_SCREEN_WITH_CURSOR = 1049
 * - BRACKETED_PASTE = 2004
 */
export declare enum TerminalMode {
    INSERT = 4,
    CURSOR_VISIBLE = 25,
    MOUSE_TRACKING_NORMAL = 1000,
    MOUSE_TRACKING_BUTTON = 1002,
    MOUSE_TRACKING_ANY = 1003,
    FOCUS_EVENTS = 1004,
    ALT_SCREEN = 1047,
    ALT_SCREEN_WITH_CURSOR = 1049,
    BRACKETED_PASTE = 2004
}
//# sourceMappingURL=types.d.ts.map