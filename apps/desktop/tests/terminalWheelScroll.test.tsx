import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal, InputHandler } from "ghostty-web";
import type {
  Ghostty,
  GhosttyTerminal,
} from "../../../vendor/ghostty-web/lib/ghostty";
import {
  DOM_DELTA_LINE,
  DOM_DELTA_PIXEL,
  LINES_PER_REPORT,
  MAX_REPORTS_PER_EVENT,
  WheelAccumulator,
  attachTerminalWheel,
  clampSensitivity,
  type WheelOptions,
  type WheelSample,
} from "../src/lib/terminalWheel";

// ---------------------------------------------------------------------------
// Simulated input sequences
// ---------------------------------------------------------------------------

const LINE_HEIGHT = 17; // canvas cell height at the default 14px font
const ROWS = 40;
const FRAME = 16;

/** Finger on the pad: 60 events, deltaY ramps 3→15→3 px (sine), every 16 ms. */
function touchpadActive(sign = 1, start = 0): WheelSample[] {
  return Array.from({ length: 60 }, (_, i) => ({
    deltaMode: DOM_DELTA_PIXEL,
    deltaY: sign * Math.round(3 + 12 * Math.sin((Math.PI * i) / 59)),
    timeStamp: start + i * FRAME,
  }));
}

/** After lift-off: kinetic tail decaying ×0.9 per frame from 12 px until < 0.5 px. */
function kineticTail(sign = 1, start = 60 * FRAME): WheelSample[] {
  const out: WheelSample[] = [];
  for (let v = 12, i = 0; v >= 0.5; v *= 0.9, i++)
    out.push({ deltaMode: DOM_DELTA_PIXEL, deltaY: sign * v, timeStamp: start + i * FRAME });
  return out;
}

/** Five mouse wheel notches, 120 ms apart. */
function wheelNotches(mode: "pixel" | "line", sign = 1): WheelSample[] {
  return Array.from({ length: 5 }, (_, i) => ({
    deltaMode: mode === "pixel" ? DOM_DELTA_PIXEL : DOM_DELTA_LINE,
    deltaY: sign * (mode === "pixel" ? 53 : 3),
    timeStamp: i * 120,
  }));
}

const totalPx = (seq: WheelSample[]) => seq.reduce((sum, s) => sum + s.deltaY, 0);

// ---------------------------------------------------------------------------
// Models of the pre-fix ghostty-web behaviour (vendor/ghostty-web/lib)
// ---------------------------------------------------------------------------

/** input-handler.ts handleWheel: one mouse report for every event with deltaY != 0. */
const legacyReports = (seq: WheelSample[]) => seq.filter((s) => s.deltaY !== 0).length;

/**
 * terminal.ts handleWheel + smoothScrollTo/animateScroll: target = viewportY - deltaLines
 * where viewportY lags behind during the 100 ms animation (1/6 of the distance per frame).
 * Returns lines scrolled once the animation settles.
 */
function legacyLocal(seq: WheelSample[]): number {
  let viewportY = 1e6;
  const startY = viewportY;
  let target = viewportY;
  let animating = false;
  let t = seq[0]?.timeStamp ?? 0;
  const step = () => {
    if (!animating) return;
    const d = target - viewportY;
    if (Math.abs(d) < 0.01) {
      viewportY = target;
      animating = false;
    } else viewportY += d / 6;
  };
  for (const s of seq) {
    while (t + FRAME <= s.timeStamp) {
      t += FRAME;
      step();
    }
    const lines = s.deltaMode === DOM_DELTA_LINE ? s.deltaY : s.deltaY / LINE_HEIGHT;
    target = viewportY - lines;
    animating = true;
  }
  for (let i = 0; i < 1000 && animating; i++) step();
  return startY - viewportY;
}

// ---------------------------------------------------------------------------
// Fixed implementation
// ---------------------------------------------------------------------------

function run(
  seq: WheelSample[],
  route: "local" | "report",
  opts: Partial<WheelOptions> = {},
) {
  const acc = new WheelAccumulator();
  const options: WheelOptions = {
    lineHeight: LINE_HEIGHT,
    rows: ROWS,
    sensitivity: 1,
    inertiaFilter: true,
    ...opts,
  };
  let lines = 0;
  let reports = 0;
  let dropped = 0;
  let maxReportsInEvent = 0;
  for (const s of seq) {
    const step = acc.feed(s, options, route);
    lines += step.lines;
    reports += step.reports;
    if (step.dropped) dropped++;
    maxReportsInEvent = Math.max(maxReportsInEvent, Math.abs(step.reports));
  }
  return { lines, reports, dropped, maxReportsInEvent };
}

const TMUX_LINES_PER_REPORT = 5; // tmux default: WheelUpPane → send -X -N 5 scroll-up

describe("wheel simulation: pre-fix vs fixed", () => {
  it("prints the comparison table", () => {
    const active = touchpadActive();
    const swipe = [...active, ...kineticTail()];
    const cases: Array<[string, WheelSample[]]> = [
      ["touchpad 60 events (no tail)", active],
      ["touchpad 60 + kinetic tail", swipe],
      ["mouse 5 notches, pixel 53", wheelNotches("pixel")],
      ["mouse 5 notches, line 3", wheelNotches("line")],
    ];
    const rows = cases.map(([name, seq]) => {
      const expected = seq.every((s) => s.deltaMode === DOM_DELTA_LINE)
        ? totalPx(seq)
        : totalPx(seq) / LINE_HEIGHT;
      const fixedLocal = run(seq, "local");
      const fixedLocalNoFilter = run(seq, "local", { inertiaFilter: false });
      const fixedReport = run(seq, "report");
      return {
        sequence: name,
        events: seq.length,
        "expected lines": +expected.toFixed(1),
        "old local": +legacyLocal(seq).toFixed(1),
        "new local": fixedLocal.lines,
        "new local (filter off)": fixedLocalNoFilter.lines,
        "old tmux reports": legacyReports(seq),
        "old tmux lines": legacyReports(seq) * TMUX_LINES_PER_REPORT,
        "new tmux reports": fixedReport.reports,
        "new tmux lines": fixedReport.reports * TMUX_LINES_PER_REPORT,
        "tail dropped": fixedLocal.dropped,
      };
    });
    console.table(rows);
    expect(rows).toHaveLength(4);
  });
});

describe("WheelAccumulator", () => {
  it("touchpad pixels convert to total displacement / line height (±1 line)", () => {
    for (const sign of [1, -1]) {
      const seq = touchpadActive(sign);
      const { lines, dropped } = run(seq, "local");
      expect(dropped).toBe(0);
      expect(Math.abs(lines - totalPx(seq) / LINE_HEIGHT)).toBeLessThanOrEqual(1);
    }
  });

  it("with the inertia filter off, swipe + tail equals displacement / line height (±1)", () => {
    const seq = [...touchpadActive(), ...kineticTail()];
    const { lines } = run(seq, "local", { inertiaFilter: false });
    expect(Math.abs(lines - totalPx(seq) / LINE_HEIGHT)).toBeLessThanOrEqual(1);
  });

  it("inertia filter drops only the slow end of the tail", () => {
    const active = touchpadActive();
    const tail = kineticTail();
    const on = run([...active, ...tail], "local");
    const off = run([...active, ...tail], "local", { inertiaFilter: false });
    expect(on.dropped).toBeGreaterThan(0);
    expect(on.lines).toBeLessThan(off.lines);
    // Active scrolling is never filtered.
    expect(on.lines).toBeGreaterThanOrEqual(Math.floor(totalPx(active) / LINE_HEIGHT) - 1);
  });

  it("does not filter slow, steady deliberate scrolling", () => {
    const seq = Array.from({ length: 40 }, (_, i) => ({
      deltaMode: DOM_DELTA_PIXEL,
      deltaY: 3 + (i % 3), // jittery 3–5 px, never a clean decay run
      timeStamp: i * FRAME,
    }));
    const { lines, dropped } = run(seq, "local");
    expect(dropped).toBe(0);
    expect(Math.abs(lines - totalPx(seq) / LINE_HEIGHT)).toBeLessThanOrEqual(1);
  });

  it("one wheel notch is about 3 lines locally and exactly one report", () => {
    const [pixelNotch] = wheelNotches("pixel");
    const [lineNotch] = wheelNotches("line");
    for (const notch of [pixelNotch, lineNotch]) {
      expect(Math.abs(run([notch], "local").lines - 3)).toBeLessThanOrEqual(1);
      expect(run([notch], "report").reports).toBe(1);
    }
    expect(run(wheelNotches("line"), "local").lines).toBe(15);
    expect(run(wheelNotches("line", -1), "report").reports).toBe(-5);
    // Wheel notches are never mistaken for inertia.
    expect(run(wheelNotches("pixel"), "local").dropped).toBe(0);
  });

  it("a notch still sends one report at large fonts (notch shorter than 3 lines)", () => {
    const acc = new WheelAccumulator();
    const step = acc.feed(
      { deltaMode: DOM_DELTA_PIXEL, deltaY: -40, timeStamp: 0 },
      { lineHeight: 28, rows: ROWS, sensitivity: 1, inertiaFilter: true },
      "report",
    );
    expect(step.reports).toBe(-1);
  });

  it("mouse-mode reports follow displacement, not event count", () => {
    const seq = touchpadActive();
    const { reports } = run(seq, "report");
    const expectedReports = totalPx(seq) / LINE_HEIGHT / LINES_PER_REPORT;
    expect(Math.abs(reports - expectedReports)).toBeLessThanOrEqual(1);
    expect(reports).toBeLessThan(legacyReports(seq) / 4);
  });

  it("caps reports per event (page mode and huge deltas)", () => {
    const acc = new WheelAccumulator();
    const step = acc.feed(
      { deltaMode: 2, deltaY: 1, timeStamp: 0 },
      { lineHeight: LINE_HEIGHT, rows: ROWS, sensitivity: 1, inertiaFilter: true },
      "report",
    );
    expect(step.reports).toBe(MAX_REPORTS_PER_EVENT);
    const local = new WheelAccumulator().feed(
      { deltaMode: 2, deltaY: -1, timeStamp: 0 },
      { lineHeight: LINE_HEIGHT, rows: ROWS, sensitivity: 1, inertiaFilter: true },
      "local",
    );
    expect(local.lines).toBe(-ROWS);
  });

  it("sensitivity scales and is clamped to 0.5–2", () => {
    const seq = touchpadActive();
    const base = run(seq, "local").lines;
    expect(Math.abs(run(seq, "local", { sensitivity: 2 }).lines - base * 2)).toBeLessThanOrEqual(1);
    expect(Math.abs(run(seq, "local", { sensitivity: 0.5 }).lines - base / 2)).toBeLessThanOrEqual(1);
    expect(clampSensitivity(10)).toBe(2);
    expect(clampSensitivity(0)).toBe(0.5);
    expect(clampSensitivity(undefined)).toBe(1);
  });

  it("direction reversal discards the opposite remainder", () => {
    const acc = new WheelAccumulator();
    const opts = { lineHeight: 20, rows: ROWS, sensitivity: 1, inertiaFilter: false };
    expect(acc.feed({ deltaMode: 0, deltaY: 15, timeStamp: 0 }, opts, "local").lines).toBe(0);
    expect(acc.feed({ deltaMode: 0, deltaY: -15, timeStamp: 16 }, opts, "local").lines).toBe(0);
    expect(acc.feed({ deltaMode: 0, deltaY: -15, timeStamp: 32 }, opts, "local").lines).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Integration with the real ghostty-web Terminal + InputHandler listeners
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function setup({ tracking = true, alternate = false, sgr = true } = {}) {
  const ghostty = { createKeyEncoder: () => ({ dispose() {} }) } as unknown as Ghostty;
  const terminal = new Terminal({ ghostty });
  terminal.wasmTerm = {
    hasMouseTracking: () => tracking,
    isAlternateScreen: () => alternate,
    getMode: (mode: number) => (mode === 1006 ? sgr : false),
    getScrollbackLength: () => (alternate ? 0 : 10000),
  } as unknown as GhosttyTerminal;
  (terminal as unknown as { isOpen: boolean }).isOpen = true;
  terminal.renderer = { charWidth: 10, charHeight: 20 } as unknown as Terminal["renderer"];
  const host = document.createElement("div");
  const canvas = document.createElement("canvas");
  host.append(canvas);
  document.body.append(host);
  const data = vi.fn();
  const sub = terminal.onData(data);
  const input = new InputHandler(
    ghostty,
    host,
    data,
    () => {},
    undefined,
    undefined,
    () => false,
    undefined,
    undefined,
    {
      hasMouseTracking: () => tracking,
      hasSgrMouseMode: () => sgr,
      getCellDimensions: () => ({ width: 10, height: 20 }),
      getCanvasOffset: () => ({ left: 0, top: 0 }),
    },
  );
  const internal = terminal as unknown as {
    handleWheel: (event: WheelEvent) => void;
    smoothScrollTo: (position: number) => void;
  };
  host.addEventListener("wheel", internal.handleWheel, { capture: true, passive: false });
  const smooth = vi.spyOn(internal, "smoothScrollTo").mockImplementation(() => {});
  const scrollLines = vi.spyOn(terminal, "scrollLines").mockImplementation(() => {});
  const settings = { scrollSensitivity: 1, touchpadInertiaFilter: true };
  const detach = attachTerminalWheel(terminal, host, () => settings);
  cleanups.push(() => {
    detach();
    input.dispose();
    sub.dispose();
    host.remove();
  });
  let now = 0;
  const wheel = (init: WheelEventInit = {}) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 15,
      clientY: 45,
      ...init,
    });
    // jsdom timeStamps are wall-clock; pin them so the gesture model is deterministic.
    Object.defineProperty(event, "timeStamp", { value: (now += FRAME) });
    canvas.dispatchEvent(event);
    return event;
  };
  return { terminal, data, wheel, smooth, scrollLines, settings };
}

describe("attachTerminalWheel with ghostty-web", () => {
  it("tmux mouse mode: a touchpad swipe sends few reports, each event handled once", () => {
    const { data, wheel, smooth } = setup();
    for (let i = 0; i < 60; i++) wheel({ deltaY: -6 }); // 360 px = 18 lines
    const sent = data.mock.calls.map(([s]) => s as string).join("");
    const reports = sent.match(/\x1b\[<64;2;3M/g) ?? [];
    expect(reports.length).toBe(6); // 18 lines / 3 — previously 60
    expect(sent.replace(/\x1b\[<64;2;3M/g, "")).toBe("");
    expect(smooth).not.toHaveBeenCalled();
  });

  it("one mouse notch in tmux sends exactly one report (no double handling)", () => {
    const { data, wheel } = setup();
    const event = wheel({ deltaY: 3, deltaMode: DOM_DELTA_LINE });
    expect(event.defaultPrevented).toBe(true);
    expect(data.mock.calls).toEqual([["\x1b[<65;2;3M"]]);
  });

  it("legacy X10 encoding when SGR mode is off", () => {
    const { data, wheel } = setup({ sgr: false });
    wheel({ deltaY: -3, deltaMode: DOM_DELTA_LINE });
    expect(data.mock.calls).toEqual([["\x1b[M`\x22\x23"]]);
  });

  it("vim/less with mouse in alternate screen also uses throttled reports", () => {
    const { data, wheel, scrollLines } = setup({ alternate: true });
    for (let i = 0; i < 10; i++) wheel({ deltaY: 4 }); // 40 px = 2 lines → no report yet
    expect(data).not.toHaveBeenCalled();
    for (let i = 0; i < 5; i++) wheel({ deltaY: 4 }); // 60 px = 3 lines → one report
    expect(data).toHaveBeenCalledTimes(1);
    expect(scrollLines).not.toHaveBeenCalled();
  });

  it("shell scrollback: scrolls whole lines locally, never sends data", () => {
    const { data, wheel, scrollLines, smooth } = setup({ tracking: false });
    for (let i = 0; i < 20; i++) wheel({ deltaY: -10 }); // 200 px = 10 lines
    expect(data).not.toHaveBeenCalled();
    expect(smooth).not.toHaveBeenCalled();
    const total = scrollLines.mock.calls.reduce((sum, [n]) => sum + (n as number), 0);
    expect(total).toBe(-10);
    expect(scrollLines.mock.calls.every(([n]) => Number.isInteger(n))).toBe(true);
  });

  it("Shift-wheel scrolls locally even when tmux tracks the mouse", () => {
    const { data, wheel, scrollLines } = setup();
    wheel({ deltaY: -3, deltaMode: DOM_DELTA_LINE, shiftKey: true });
    expect(data).not.toHaveBeenCalled();
    expect(scrollLines).toHaveBeenCalledWith(-3);
  });

  it("settings apply immediately", () => {
    const { wheel, scrollLines, settings } = setup({ tracking: false });
    settings.scrollSensitivity = 2;
    wheel({ deltaY: -3, deltaMode: DOM_DELTA_LINE });
    expect(scrollLines).toHaveBeenLastCalledWith(-6);
  });

  it("horizontal-only wheel does nothing", () => {
    const { data, wheel, scrollLines } = setup();
    wheel({ deltaX: 99, deltaY: 0 });
    expect(data).not.toHaveBeenCalled();
    expect(scrollLines).not.toHaveBeenCalled();
  });
});
