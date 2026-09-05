import { ILink, ILinkProvider } from '../types';
/**
 * URL Regex Provider
 *
 * Detects plain text URLs using regex. Handles URLs that have been
 * soft-wrapped across multiple buffer rows by joining the rows in the
 * wrap chain that contains the queried row before applying the regex.
 *
 * Supported protocols:
 * - https://, http://
 * - mailto:
 * - ftp://, ssh://, git://
 * - tel:, magnet:
 * - gemini://, gopher://, news:
 *
 * Wrap-chain semantics: a buffer line's `isWrapped` flag is `true` when
 * the line is the *continuation* of a soft-wrap from the previous line.
 * To find the chain that contains row `y` we walk backwards from `y`
 * while the current row's `isWrapped` is true, then forwards from there
 * while the next row's `isWrapped` is true.
 */
export declare class UrlRegexProvider implements ILinkProvider {
    private terminal;
    /**
     * URL regex pattern
     * Matches common protocols followed by valid URL characters
     * Excludes file paths (no ./ or ../ or bare /)
     */
    private static readonly URL_REGEX;
    /**
     * Characters to strip from end of URLs
     * Common punctuation that's unlikely to be part of the URL
     */
    private static readonly TRAILING_PUNCTUATION;
    /**
     * Maximum number of soft-wrapped rows to traverse in either direction
     * when assembling a wrap chain. Bounds worst-case work on pathological
     * input (e.g. a screenful of unbroken characters); any real URL fits
     * easily.
     */
    private static readonly MAX_WRAP_CHAIN_ROWS;
    constructor(terminal: ITerminalForUrlProvider);
    /**
     * Provide all regex-detected URLs whose range intersects the given row.
     *
     * For wrapped URLs the same link is returned no matter which row in the
     * chain the caller queries. The link's `range` may span multiple rows;
     * `LinkManager.isPositionInLink` correctly handles such ranges.
     */
    provideLinks(y: number, callback: (links: ILink[] | undefined) => void): void;
    /**
     * Convert a buffer line to plain text string. Control characters and
     * empty cells become spaces so column indices map 1:1 onto the string.
     */
    private lineToText;
    /**
     * Map an index in the joined string back to a (col, row) buffer position.
     */
    private joinedIdxToRowCol;
    dispose(): void;
}
/**
 * Minimal terminal interface required by UrlRegexProvider
 */
export declare function openLinkFromEvent(event: MouseEvent, url: string): void;
interface ITerminalForUrlProvider {
    buffer: {
        active: {
            /** Total number of rows accessible via `getLine` (viewport + scrollback). */
            length: number;
            getLine(y: number): IBufferLineForUrlProvider | undefined;
        };
    };
}
/**
 * Minimal buffer line interface for URL detection
 */
interface IBufferLineForUrlProvider {
    length: number;
    /**
     * `true` when this line is the continuation of a soft-wrap from the
     * previous line — i.e. the previous line was wider than `cols` and
     * spilled here.
     */
    isWrapped: boolean;
    getCell(x: number): {
        getCodepoint(): number;
    } | undefined;
}
export {};
//# sourceMappingURL=url-regex-provider.d.ts.map