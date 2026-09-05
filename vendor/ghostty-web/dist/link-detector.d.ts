import { ILink, ILinkProvider } from './types';
/**
 * Manages link detection across multiple providers with intelligent caching
 */
export declare class LinkDetector {
    private terminal;
    private providers;
    private linkCache;
    private scannedRows;
    constructor(terminal: ITerminalForLinkDetector);
    /**
     * Register a link provider
     */
    registerProvider(provider: ILinkProvider): void;
    /**
     * Get link at the specified buffer position
     * @param col Column (0-based)
     * @param row Absolute row in buffer (0-based)
     * @returns Link at position, or undefined if none
     */
    getLinkAt(col: number, row: number): Promise<ILink | undefined>;
    /**
     * Scan a row for links using all registered providers
     */
    private scanRow;
    /**
     * Cache a link for fast lookup
     *
     * Note: We cache by position range, not hyperlink_id, because the WASM
     * returns hyperlink_id as a boolean (0 or 1), not a unique identifier.
     * The actual unique identifier is the URI which is retrieved separately.
     */
    private cacheLink;
    /**
     * Check if a position is within a link's range
     */
    private isPositionInLink;
    /**
     * Invalidate cache when terminal content changes
     * Should be called on terminal write, resize, or clear
     */
    invalidateCache(): void;
    /**
     * Invalidate cache for specific rows
     * Used when only part of the terminal changed
     */
    invalidateRows(startRow: number, endRow: number): void;
    /**
     * Dispose and cleanup
     */
    dispose(): void;
}
/**
 * Minimal terminal interface required by LinkDetector
 * Keeps coupling low and testing easy
 */
export interface ITerminalForLinkDetector {
    buffer: {
        active: {
            getLine(y: number): {
                length: number;
                getCell(x: number): {
                    getHyperlinkId(): number;
                } | undefined;
            } | undefined;
        };
    };
}
//# sourceMappingURL=link-detector.d.ts.map