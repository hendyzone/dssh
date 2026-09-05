import { Ghostty } from './ghostty';
import { IKeyEvent } from './interfaces';
/**
 * InputHandler class
 * Attaches keyboard event listeners to a container and converts
 * keyboard events to terminal input data
 */
/**
 * Mouse tracking configuration
 */
export interface MouseTrackingConfig {
    /** Check if any mouse tracking mode is enabled */
    hasMouseTracking: () => boolean;
    /** Check if SGR extended mouse mode is enabled (mode 1006) */
    hasSgrMouseMode: () => boolean;
    /** Get cell dimensions for pixel to cell conversion */
    getCellDimensions: () => {
        width: number;
        height: number;
    };
    /** Get canvas/container offset for accurate position calculation */
    getCanvasOffset: () => {
        left: number;
        top: number;
    };
}
export declare class InputHandler {
    private encoder;
    private container;
    private inputElement?;
    private onDataCallback;
    private onBellCallback;
    private onKeyCallback?;
    private customKeyEventHandler?;
    private getModeCallback?;
    private onCopyCallback?;
    private mouseConfig?;
    private keydownListener;
    private keypressListener;
    private pasteListener;
    private beforeInputListener;
    private compositionStartListener;
    private compositionUpdateListener;
    private compositionEndListener;
    private mousedownListener;
    private mouseupListener;
    private mousemoveListener;
    private wheelListener;
    private blurListener;
    private isComposing;
    private compositionJustEnded;
    private pendingKeyAfterComposition;
    private isDisposed;
    private mouseButtonsPressed;
    private lastKeyDownData;
    private lastKeyDownTime;
    private lastPasteData;
    private lastPasteTime;
    private lastPasteSource;
    private lastCompositionData;
    private lastCompositionTime;
    private lastBeforeInputData;
    private lastBeforeInputTime;
    private static readonly BEFORE_INPUT_IGNORE_MS;
    /**
     * Create a new InputHandler
     * @param ghostty - Ghostty instance (for creating KeyEncoder)
     * @param container - DOM element to attach listeners to
     * @param onData - Callback for terminal data (escape sequences to send to PTY)
     * @param onBell - Callback for bell/beep event
     * @param onKey - Optional callback for raw key events
     * @param customKeyEventHandler - Optional custom key event handler
     * @param getMode - Optional callback to query terminal mode state (for application cursor mode)
     * @param onCopy - Optional callback to handle copy (Cmd+C/Ctrl+C with selection)
     * @param inputElement - Optional input element for beforeinput events
     * @param mouseConfig - Optional mouse tracking configuration
     */
    constructor(ghostty: Ghostty, container: HTMLElement, onData: (data: string) => void, onBell: () => void, onKey?: (keyEvent: IKeyEvent) => void, customKeyEventHandler?: (event: KeyboardEvent) => boolean | undefined, getMode?: (mode: number) => boolean, onCopy?: () => boolean, inputElement?: HTMLElement, mouseConfig?: MouseTrackingConfig);
    /**
     * Set custom key event handler (for runtime updates)
     * Returns: true = terminal handles it, false = let it bubble, undefined = default processing
     */
    setCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean | undefined): void;
    /**
     * Attach keyboard event listeners to container
     */
    private attach;
    /**
     * Map KeyboardEvent.code to USB HID Key enum value
     * @param code - KeyboardEvent.code value
     * @returns Key enum value or null if unmapped
     */
    private mapKeyCode;
    /**
     * Extract modifier flags from KeyboardEvent
     * @param event - KeyboardEvent
     * @returns Mods flags
     */
    private extractModifiers;
    /**
     * Check if this is a printable character with no special modifiers
     * @param event - KeyboardEvent
     * @returns true if printable character
     */
    private isPrintableCharacter;
    /**
     * Handle keydown event
     * @param event - KeyboardEvent
     */
    private handleKeyDown;
    /**
     * Handle paste event from clipboard
     * @param event - ClipboardEvent
     */
    private handlePaste;
    /**
     * Handle beforeinput event (mobile/IME input)
     * @param event - InputEvent
     */
    private handleBeforeInput;
    /**
     * Handle compositionstart event
     */
    private handleCompositionStart;
    /**
     * Handle compositionupdate event
     */
    private handleCompositionUpdate;
    /**
     * Handle compositionend event
     */
    private handleCompositionEnd;
    /**
     * Process the pending key that was queued during composition
     */
    private processPendingKeyAfterComposition;
    /**
     * Cleanup text nodes in container after composition
     */
    private cleanupCompositionTextNodes;
    /**
     * Convert pixel coordinates to terminal cell coordinates
     */
    private pixelToCell;
    /**
     * Get modifier flags for mouse event
     */
    private getMouseModifiers;
    /**
     * Encode mouse event as SGR sequence
     * SGR format: \x1b[<Btn;Col;RowM (press/motion) or \x1b[<Btn;Col;Rowm (release)
     */
    private encodeMouseSGR;
    /**
     * Encode mouse event as X10/normal sequence (legacy format)
     * Format: \x1b[M<Btn+32><Col+32><Row+32>
     */
    private encodeMouseX10;
    /**
     * Send mouse event to terminal
     */
    private sendMouseEvent;
    /**
     * Handle mousedown event
     */
    private handleMouseDown;
    /**
     * Handle mouseup event
     *
     * Listens on `document`, so this fires even when the release happens
     * outside the terminal canvas. Two behaviors flow from that:
     *
     *   - Always clear the pressed-button bit before any early return, so
     *     a release outside the canvas still cleans up local state and
     *     subsequent motion doesn't look like a drag.
     *   - Only forward the release to the PTY if this instance previously
     *     saw the matching press. Otherwise, in a page with multiple
     *     terminals, every instance would send a spurious release for every
     *     mouseup anywhere on the document.
     */
    private handleMouseUp;
    /**
     * Handle window blur — clear all pressed-button state so a held button
     * doesn't stay flagged as pressed after Alt-Tab or focus loss.
     */
    private handleWindowBlur;
    /**
     * Handle mousemove event
     */
    private handleMouseMove;
    /**
     * Handle wheel event (scroll)
     */
    private handleWheel;
    /**
     * Emit paste data with bracketed paste support
     */
    private emitPasteData;
    /**
     * Record keydown data for beforeinput de-duplication
     */
    private recordKeyDownData;
    /**
     * Record paste data for beforeinput de-duplication
     */
    private recordPasteData;
    /**
     * Check if beforeinput should be ignored due to a recent keydown
     */
    private shouldIgnoreBeforeInput;
    /**
     * Check if beforeinput text should be ignored due to a recent composition end
     */
    private shouldIgnoreBeforeInputFromComposition;
    /**
     * Check if composition end should be ignored due to a recent beforeinput text
     */
    private shouldIgnoreCompositionEnd;
    /**
     * Record beforeinput text for composition de-duplication
     */
    private recordBeforeInputData;
    /**
     * Record composition end data for beforeinput de-duplication
     */
    private recordCompositionData;
    /**
     * Check if paste should be ignored due to a recent paste event from another source
     */
    private shouldIgnorePasteEvent;
    /**
     * Get current time in milliseconds
     */
    private getNow;
    /**
     * Dispose the InputHandler and remove event listeners
     */
    dispose(): void;
    /**
     * Check if handler is disposed
     */
    isActive(): boolean;
}
//# sourceMappingURL=input-handler.d.ts.map