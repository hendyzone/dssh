import { CellMetrics, RenderInput, Renderer, TerminalTheme } from './types';
export interface WebGLRendererOptions {
    fontSize?: number;
    fontFamily?: string;
    fontWeight?: number;
    devicePixelRatio?: number;
    antialias?: boolean;
    alpha?: boolean;
    onContextLoss?: () => void;
    ownerDocument?: Document;
}
export declare class WebGLRenderer implements Renderer {
    private canvas?;
    private gl?;
    private options;
    private fontSize;
    private fontFamily;
    private fontWeight;
    private dpr;
    private fixedDevicePixelRatio?;
    private metrics;
    private theme;
    private cellBuffer?;
    private glyphAtlas?;
    private quadVbo?;
    private background?;
    private glyph?;
    private decoration?;
    private solid?;
    private gridCols;
    private gridRows;
    private cellSizePx;
    private contextValid;
    private contextLossCount;
    private forceFullUpload;
    private sceneFramebuffer?;
    private sceneTexture?;
    private sceneWidth;
    private sceneHeight;
    private postProcessProgram?;
    private customPostProcessSource;
    private postProcessActive;
    private postProcessStartTime;
    constructor(options?: WebGLRendererOptions);
    attach(canvas: HTMLCanvasElement): void;
    resize(cols: number, rows: number): void;
    render(input: RenderInput): void;
    updateTheme(theme: TerminalTheme): void;
    /**
     * Install (or clear) a custom post-process fragment shader, run as a final
     * fullscreen composite pass after the terminal's own background/glyph/
     * decoration/cursor/scrollbar passes.
     *
     * Once any non-null shader is installed, rendering switches from "draw
     * straight to the canvas" to "draw to an offscreen scene texture, then
     * composite via this shader" — an extra same-context texture sample + draw
     * call per frame, not a cross-context canvas copy, so it doesn't pay the
     * GPU/driver synchronization cost of copying a *live, separately-rendering*
     * WebGL canvas into another context (which is what made an earlier
     * external-overlay prototype visibly stall typing in btmux). Passing null
     * reverts to the zero-overhead direct-to-canvas path.
     *
     * Shader contract (GLSL ES 3.00):
     *   in vec2 v_uv;              // 0..1, already oriented to match the terminal grid
     *   uniform sampler2D u_scene; // the rendered terminal frame
     *   uniform vec2 u_resolution; // scene texture size in device pixels (optional)
     *   uniform float u_time;      // seconds since this shader was installed (optional)
     *   out vec4 fragColor;
     *
     * u_resolution/u_time are looked up leniently — omit them if unused.
     * Compile/link failures are logged and fall back to an unmodified
     * passthrough composite rather than losing terminal output.
     */
    setPostProcessShader(fragmentSource: string | null): void;
    setFontSize(size: number): void;
    setFontFamily(family: string): void;
    setFontWeight(weight: number): void;
    remeasureFont(): void;
    getMetrics(): CellMetrics;
    getCanvas(): HTMLCanvasElement;
    get charWidth(): number;
    get charHeight(): number;
    clear(): void;
    dispose(): void;
    private initResources;
    private releaseResources;
    private deleteProgramInfo;
    private resizeSceneFramebuffer;
    private disposeSceneFramebuffer;
    private compilePostProcessProgram;
    private disposePostProcessProgram;
    private blitScene;
    private prepareFrame;
    private updateInstanceData;
    private drawFramePasses;
    private drawOverlays;
    private createProgramInfo;
    private drawSolidRect;
    private drawScrollbar;
    private getDevicePixelRatio;
    private measureFont;
    private setDevicePixelRatio;
    private handleContextLost;
    private handleContextRestored;
}
//# sourceMappingURL=WebGLRenderer.d.ts.map