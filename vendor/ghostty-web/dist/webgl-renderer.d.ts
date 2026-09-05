import { ITerminalDecoration, ITheme } from './interfaces';
import { FontMetrics, IRenderable, IScrollbackProvider, RendererOptions } from './renderer';
import { ITerminalRenderer } from './renderer-contract';
import { SelectionManager } from './selection-manager';
/**
 * Terminal-facing WebGL renderer adapter.
 *
 * This class intentionally does not extend CanvasRenderer: a canvas can only
 * own one rendering context, so grabbing a 2D context first would make WebGL2
 * initialization impossible. It implements the same Terminal-facing contract
 * and translates the current pull-model terminal state into libghostty-webgl's
 * push-model RenderInput.
 */
export declare class WebGLRenderer implements ITerminalRenderer {
    private canvas;
    private options;
    private vendored;
    private theme;
    private allowTransparency;
    private cols;
    private rows;
    private selectionManager?;
    private onRequestRender?;
    private hoveredHyperlinkId;
    private hoveredLinkRange;
    private decorations;
    private preeditOverlay?;
    private cursorVisible;
    private cursorBlinkInterval?;
    private scrollbarWidth;
    static canUse(canvas: HTMLCanvasElement): boolean;
    constructor(canvas: HTMLCanvasElement, options?: RendererOptions);
    get charWidth(): number;
    get charHeight(): number;
    resize(cols: number, rows: number): void;
    render(buffer: IRenderable, forceAll?: boolean, viewportY?: number, scrollbackProvider?: IScrollbackProvider, scrollbarOpacity?: number): void;
    clear(): void;
    dispose(): void;
    getMetrics(): FontMetrics;
    getCanvas(): HTMLCanvasElement;
    setTheme(theme: ITheme): void;
    setAllowTransparency(allowTransparency: boolean): void;
    setFontSize(fontSize: number): void;
    setFontFamily(fontFamily: string): void;
    setFontWeight(weight: number): void;
    remeasureFont(): void;
    setCursorStyle(style: 'block' | 'underline' | 'bar'): void;
    setCursorBlink(blink: boolean): void;
    setScrollbarWidth(width: number): void;
    setSelectionManager(selectionManager: SelectionManager): void;
    setHoveredHyperlinkId(id: number | null): void;
    setHoveredLinkRange(range: {
        startX: number;
        startY: number;
        endX: number;
        endY: number;
    } | null): void;
    setDecorations(decorations: ITerminalDecoration[]): void;
    clearDecorations(): void;
    attachOverlayTo(parent: HTMLElement): void;
    drawPreedit(text: string, cellX?: number, cellY?: number): void;
    clearPreedit(): void;
    setOnRequestRender(onRequestRender: () => void): void;
    /**
     * See VendoredWebGLRenderer.setPostProcessShader for the shader contract.
     *
     * Wakes the terminal for one fresh frame: ghostty-web only repaints on its
     * own event-driven wake points (PTY writes, cursor blink, etc — see
     * Terminal.requestRender), so an idle terminal wouldn't otherwise pick up
     * a shader swap until the next unrelated wake, which could be up to a
     * cursor-blink-interval away. A single wake is enough for a static effect;
     * an animated one (e.g. a shader whose u_time drives a ramp) needs the
     * caller to keep calling requestRender() for the animation's duration —
     * see requestRender below.
     */
    setPostProcessShader(fragmentSource: string | null): void;
    /**
     * Force a render on the next frame. Exposed so callers driving a
     * u_time-based post-process animation (e.g. a ramp in/out) can pump
     * continuous frames while the terminal is otherwise idle and wouldn't
     * repaint on its own — call this once per requestAnimationFrame tick for
     * the animation's duration.
     */
    requestRender(): void;
    private startCursorBlink;
    private stopCursorBlink;
    private buildRenderInput;
    private getRenderLineSource;
    private getViewportLineCellReader;
    private rowIntersectsSelection;
    private rowIntersectsHoveredLink;
    private emptyCell;
    private toWebGLDecorations;
    private toWebGLTheme;
    private cssToRgba;
}
//# sourceMappingURL=webgl-renderer.d.ts.map