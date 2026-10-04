import type { Terminal } from "ghostty-web";

/**
 * Terminal wheel/touchpad handling.
 *
 * ghostty-web's built-in path sends ONE mouse report per WheelEvent whenever an
 * application (tmux mouse mode, vim mouse=a, ...) enables mouse tracking, no
 * matter how small deltaY is. A touchpad under WebKitGTK emits dozens of small
 * pixel events per swipe plus a kinetic tail, and tmux scrolls 5 lines per
 * report, so a short swipe overshoots by an order of magnitude.
 *
 * This module owns every wheel event (via attachCustomWheelEventHandler, so the
 * built-in local-scroll and mouse-report listeners never see it) and converts
 * deltas to lines with an accumulator: fractions carry over to the next event,
 * nothing is amplified, and mouse reports are emitted per LINES_PER_REPORT
 * lines instead of per event.
 */

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;

/** One mouse wheel report stands for this many lines (one classic wheel notch). */
export const LINES_PER_REPORT = 3;
/** Cap of reports per WheelEvent; excess is dropped rather than queued. */
export const MAX_REPORTS_PER_EVENT = 3;
/** A pixel event at least this large is a discrete wheel notch, not a touchpad step. */
export const NOTCH_MIN_PX = 36;
/** Events further apart than this start a new gesture. */
export const GESTURE_GAP_MS = 150;

export const MIN_SCROLL_SENSITIVITY = 0.5;
export const MAX_SCROLL_SENSITIVITY = 2;

export interface WheelSample {
  deltaMode: number;
  deltaY: number;
  timeStamp: number;
}

export interface WheelOptions {
  /** Cell height in CSS pixels. */
  lineHeight: number;
  /** Visible rows (page-mode conversion). */
  rows: number;
  /** User multiplier, 0.5–2. */
  sensitivity: number;
  /** Drop the slow tail of touchpad kinetic scrolling. */
  inertiaFilter: boolean;
}

export function clampSensitivity(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : 1;
  return Math.min(MAX_SCROLL_SENSITIVITY, Math.max(MIN_SCROLL_SENSITIVITY, n));
}

/** Raw delta in lines, honoring deltaMode semantics (no sensitivity). */
export function deltaToLines(sample: WheelSample, lineHeight: number, rows: number): number {
  if (sample.deltaMode === DOM_DELTA_LINE) return sample.deltaY;
  if (sample.deltaMode === DOM_DELTA_PAGE) return sample.deltaY * Math.max(1, rows);
  return sample.deltaY / (lineHeight > 0 ? lineHeight : 20);
}

/** Delta in CSS pixels, used for speed/inertia heuristics. */
function deltaToPixels(sample: WheelSample, lineHeight: number, rows: number): number {
  if (sample.deltaMode === DOM_DELTA_PIXEL) return sample.deltaY;
  return deltaToLines(sample, lineHeight, rows) * (lineHeight > 0 ? lineHeight : 20);
}

/**
 * Detects the decaying tail a touchpad emits after the fingers lift. The DOM
 * exposes no momentum phase, so the tail is recognised by shape: a run of
 * strictly decreasing pixel deltas that has decayed well below the gesture's peak.
 * Only that low-speed part is dropped; active scrolling and wheel notches pass.
 */
export class InertiaFilter {
  private lastTime = -Infinity;
  private lastDir = 0;
  private prevMag = 0;
  private peak = 0;
  private decayRun = 0;
  private coasting = false;

  /** Thresholds: decay run length, fraction of peak, and absolute speed in lines/event. */
  static readonly DECAY_RUN = 6;
  static readonly PEAK_FRACTION = 0.35;
  static readonly SLOW_LINES = 0.4;

  reset(): void {
    this.lastTime = -Infinity;
    this.lastDir = 0;
    this.prevMag = 0;
    this.peak = 0;
    this.decayRun = 0;
    this.coasting = false;
  }

  /** Returns true when the event should be dropped. */
  shouldDrop(sample: WheelSample, px: number, lineHeight: number): boolean {
    const mag = Math.abs(px);
    const dir = Math.sign(px);
    const discrete = sample.deltaMode !== DOM_DELTA_PIXEL || mag >= NOTCH_MIN_PX;
    const gap = sample.timeStamp - this.lastTime;
    this.lastTime = sample.timeStamp;
    if (discrete || gap > GESTURE_GAP_MS || dir !== this.lastDir) {
      this.lastDir = dir;
      this.prevMag = mag;
      this.peak = mag;
      this.decayRun = 0;
      this.coasting = false;
      return false;
    }
    if (this.coasting) {
      // Speeding up again: the fingers are back on the pad.
      if (mag > this.prevMag * 1.5) {
        this.coasting = false;
        this.decayRun = 0;
        this.peak = mag;
      }
    } else if (mag < this.prevMag * 0.98) {
      // Kinetic deceleration produces a strictly shrinking delta every frame;
      // a finger produces plateaus and jitter, which reset the run.
      this.decayRun += 1;
    } else {
      this.decayRun = 0;
      this.peak = Math.max(this.peak, mag);
    }
    this.prevMag = mag;
    if (
      !this.coasting &&
      this.decayRun >= InertiaFilter.DECAY_RUN &&
      mag <= this.peak * InertiaFilter.PEAK_FRACTION &&
      mag < InertiaFilter.SLOW_LINES * (lineHeight > 0 ? lineHeight : 20)
    )
      this.coasting = true;
    return this.coasting;
  }
}

/** Truncate towards zero, tolerating float drift (0.3 × 10 = 2.9999…), never -0. */
function truncate(value: number): number {
  return Math.trunc(value + Math.sign(value) * 1e-9) || 0;
}

export interface WheelStep {
  /** Whole lines to scroll the local viewport (positive = towards newer output). */
  lines: number;
  /** Signed number of mouse wheel reports to send (positive = wheel down). */
  reports: number;
  /** The event was recognised as inertia tail and ignored. */
  dropped: boolean;
}

/**
 * Pure accumulator: feed WheelEvents, get whole lines / report counts out.
 * Local lines and report counts use separate accumulators so switching between
 * shell scrollback and tmux mouse mode never leaks remainders across.
 */
export class WheelAccumulator {
  private localAcc = 0;
  private reportAcc = 0;
  readonly inertia = new InertiaFilter();

  reset(): void {
    this.localAcc = 0;
    this.reportAcc = 0;
    this.inertia.reset();
  }

  feed(sample: WheelSample, opts: WheelOptions, mode: "local" | "report"): WheelStep {
    if (!sample.deltaY || !Number.isFinite(sample.deltaY))
      return { lines: 0, reports: 0, dropped: false };
    const px = deltaToPixels(sample, opts.lineHeight, opts.rows);
    const drop = this.inertia.shouldDrop(sample, px, opts.lineHeight);
    if (drop && opts.inertiaFilter) return { lines: 0, reports: 0, dropped: true };
    const lines = deltaToLines(sample, opts.lineHeight, opts.rows) * clampSensitivity(opts.sensitivity);

    if (mode === "local") {
      if (Math.sign(lines) !== Math.sign(this.localAcc)) this.localAcc = 0;
      this.localAcc += lines;
      const whole = truncate(this.localAcc);
      this.localAcc -= whole;
      return { lines: whole, reports: 0, dropped: false };
    }

    if (Math.sign(lines) !== Math.sign(this.reportAcc)) this.reportAcc = 0;
    this.reportAcc += lines;
    let count = truncate(this.reportAcc / LINES_PER_REPORT);
    this.reportAcc -= count * LINES_PER_REPORT;
    // A discrete wheel notch always produces one report, even when the
    // browser's notch is shorter than LINES_PER_REPORT lines at large fonts.
    const discrete =
      sample.deltaMode !== DOM_DELTA_PIXEL || Math.abs(sample.deltaY) >= NOTCH_MIN_PX;
    if (count === 0 && discrete) {
      count = Math.sign(lines);
      this.reportAcc = 0;
    }
    if (Math.abs(count) > MAX_REPORTS_PER_EVENT) count = Math.sign(count) * MAX_REPORTS_PER_EVENT;
    return { lines: 0, reports: count || 0, dropped: false };
  }
}

export interface WheelSettings {
  scrollSensitivity?: number;
  touchpadInertiaFilter?: boolean;
}

interface WheelLogEntry {
  t: number;
  mode: number;
  dy: number;
  route: "local" | "report";
  lines: number;
  reports: number;
  dropped: boolean;
}

/**
 * Wheel diagnostics. Enabled in dev builds, or in any build with
 * localStorage["dssh.wheelDebug"] = "1". Read back from devtools with
 * `__dsshWheelLog` (last 500 events).
 */
function wheelDebugEnabled(): boolean {
  try {
    return (
      (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true ||
      localStorage.getItem("dssh.wheelDebug") === "1"
    );
  } catch {
    return false;
  }
}

function logWheel(entry: WheelLogEntry): void {
  const g = globalThis as { __dsshWheelLog?: WheelLogEntry[] };
  const log = (g.__dsshWheelLog ??= []);
  log.push(entry);
  if (log.length > 500) log.splice(0, log.length - 500);
}

function encodeWheelReport(
  terminal: Terminal,
  down: boolean,
  col: number,
  row: number,
  event: WheelEvent,
): string {
  let mods = 0;
  if (event.shiftKey) mods |= 4;
  if (event.metaKey) mods |= 8;
  if (event.ctrlKey) mods |= 16;
  const button = (down ? 65 : 64) + mods;
  let sgr = true;
  try {
    sgr = terminal.getMode(1006, false);
  } catch {
    /* not open: default to SGR like ghostty-web */
  }
  if (sgr) return `\x1b[<${button};${col};${row}M`;
  const ch = (n: number) => String.fromCharCode(Math.min(n + 32, 255));
  return `\x1b[M${String.fromCharCode(button + 32)}${ch(col)}${ch(row)}`;
}

/**
 * Take over wheel handling for a ghostty-web terminal. `getSettings` is read on
 * every event so changes apply immediately.
 */
export function attachTerminalWheel(
  terminal: Terminal,
  root: HTMLElement,
  getSettings: () => WheelSettings,
): () => void {
  const acc = new WheelAccumulator();
  const metrics = () => {
    const r = terminal.renderer as { charWidth?: number; charHeight?: number } | undefined;
    const lineHeight = r?.charHeight && r.charHeight > 0 ? r.charHeight : 20;
    const charWidth = r?.charWidth && r.charWidth > 0 ? r.charWidth : 10;
    return { lineHeight, charWidth };
  };
  const cellAt = (event: WheelEvent, charWidth: number, lineHeight: number) => {
    const canvas = root.querySelector("canvas") ?? root;
    const rect = canvas.getBoundingClientRect();
    const col = Math.floor((event.clientX - rect.left) / charWidth) + 1;
    const row = Math.floor((event.clientY - rect.top) / lineHeight) + 1;
    return {
      col: Math.min(Math.max(1, col), Math.max(1, terminal.cols)),
      row: Math.min(Math.max(1, row), Math.max(1, terminal.rows)),
    };
  };

  const handle = (event: WheelEvent): boolean => {
    // Returning true makes ghostty-web stop the event: neither its local
    // scroll nor its InputHandler mouse report runs, so nothing is doubled.
    if (!event.deltaY) return true;
    const settings = getSettings();
    const { lineHeight, charWidth } = metrics();
    let tracking = false;
    try {
      tracking = !event.shiftKey && terminal.hasMouseTracking();
    } catch {
      tracking = false;
    }
    const route = tracking ? "report" : "local";
    const step = acc.feed(
      { deltaMode: event.deltaMode, deltaY: event.deltaY, timeStamp: event.timeStamp },
      {
        lineHeight,
        rows: terminal.rows,
        sensitivity: clampSensitivity(settings.scrollSensitivity),
        inertiaFilter: settings.touchpadInertiaFilter !== false,
      },
      route,
    );
    if (wheelDebugEnabled())
      logWheel({
        t: Math.round(event.timeStamp),
        mode: event.deltaMode,
        dy: event.deltaY,
        route,
        lines: step.lines,
        reports: step.reports,
        dropped: step.dropped,
      });
    if (step.lines) terminal.scrollLines(step.lines);
    if (step.reports) {
      const { col, row } = cellAt(event, charWidth, lineHeight);
      const seq = encodeWheelReport(terminal, step.reports > 0, col, row, event);
      terminal.clearSelection();
      terminal.input(seq.repeat(Math.abs(step.reports)), true);
    }
    return true;
  };

  // Test doubles (and older ghostty-web builds) may lack the hook.
  if (typeof terminal.attachCustomWheelEventHandler !== "function") return () => {};
  terminal.attachCustomWheelEventHandler(handle);
  return () => terminal.attachCustomWheelEventHandler(undefined);
}
