/**
 * Combining diacritics used by the kitty graphics protocol to encode
 * row / column positions inside Unicode placeholder cells.
 *
 * Each diacritic codepoint here represents an integer equal to its
 * 0-based index in this list. So U+0305 = 0, U+030D = 1, U+030E = 2,
 * and so on through 296. A placeholder cell stacks combining marks on
 * U+10EEEE; the first encodes the row index, the second encodes the
 * column index, and an optional third encodes the high byte of the
 * image id (since the foreground color only carries 24 bits and image
 * ids can be 32 bits wide).
 *
 * Source-of-truth: kovidgoyal/kitty:gen/rowcolumn-diacritics.txt
 * (Unicode 6.0.0 combining chars of class 230 that don't precompose;
 * see kitty's docs for the full derivation rationale).
 */
export declare const ROWCOLUMN_DIACRITICS: readonly number[];
export declare function diacriticToInt(cp: number): number;
/**
 * Unicode codepoint for the kitty graphics placeholder cell.
 * Cells with this codepoint are substituted with an image slice at
 * render time rather than rendered as text.
 */
export declare const KITTY_PLACEHOLDER = 1109742;
//# sourceMappingURL=kitty_diacritics.d.ts.map