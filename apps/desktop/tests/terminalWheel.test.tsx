import { afterEach, describe, expect, it, vi } from "vitest";
import { Terminal, InputHandler } from "ghostty-web";
import type {
  Ghostty,
  GhosttyTerminal,
} from "../../../vendor/ghostty-web/lib/ghostty";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function setup({ tracking = true, alternate = true, sgr = true } = {}) {
  const ghostty = {
    createKeyEncoder: () => ({ dispose() {} }),
  } as unknown as Ghostty;
  const terminal = new Terminal({ ghostty });
  terminal.wasmTerm = {
    hasMouseTracking: () => tracking,
    isAlternateScreen: () => alternate,
  } as GhosttyTerminal;
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
  // Reproduce Terminal.open's capture listener and InputHandler's bubble listener
  // on a real DOM tree, while isolating the unrelated WASM/canvas renderer.
  const internal = terminal as unknown as {
    handleWheel: (event: WheelEvent) => void;
    smoothScrollTo: (position: number) => void;
  };
  host.addEventListener("wheel", internal.handleWheel, {
    capture: true,
    passive: false,
  });
  const scroll = vi
    .spyOn(internal, "smoothScrollTo")
    .mockImplementation(() => {});
  cleanups.push(() => {
    input.dispose();
    sub.dispose();
    host.remove();
  });
  const wheel = (init: WheelEventInit = {}, target: HTMLElement = canvas) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: 15,
      clientY: 45,
      deltaY: -99,
      ...init,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { terminal, data, scroll, wheel, host };
}

describe("terminal wheel routing", () => {
  it.each([true, false])(
    "routes wheel to mouse reporting on alternate=%s",
    (alternate) => {
      const { data, wheel, scroll } = setup({ alternate });
      wheel();
      expect(data.mock.calls).toEqual([["\x1b[<64;2;3M"]]);
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it("reports downward wheel coordinates instead of down-arrow keys", () => {
    const { data, wheel } = setup();
    wheel({ deltaY: 99 });
    expect(data.mock.calls).toEqual([["\x1b[<65;2;3M"]]);
  });

  it("supports legacy mouse encoding", () => {
    const { data, wheel } = setup({ sgr: false });
    wheel();
    expect(data.mock.calls).toEqual([["\x1b[M`\x22\x23"]]);
  });

  it("keeps shell history scrolling local outside alternate screen", () => {
    const { data, scroll, wheel } = setup({
      tracking: false,
      alternate: false,
    });
    wheel();
    expect(data).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalled();
  });

  it("scrolls locally without changing input history in alternate-screen applications", () => {
    const { data, wheel, scroll } = setup({ tracking: false });
    wheel();
    expect(data).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalled();
  });

  it("Shift-wheel bypasses remote mouse reporting and arrow emulation", () => {
    const { data, scroll, wheel } = setup();
    wheel({ shiftKey: true });
    expect(data).not.toHaveBeenCalled();
    expect(scroll).toHaveBeenCalled();
  });

  it("horizontal-only wheel does not send a downward mouse event", () => {
    const { data, wheel } = setup();
    wheel({ deltaX: 99, deltaY: 0 });
    expect(data).not.toHaveBeenCalled();
  });

  it("custom handling also prevents duplicate reporting when the host is the target", () => {
    const { terminal, data, wheel, host } = setup();
    terminal.attachCustomWheelEventHandler(() => true);
    wheel({}, host);
    expect(data).not.toHaveBeenCalled();
  });
});

it("Shift drag bypasses tmux mouse reporting but normal drag still reports", () => {
  const {host,data} = setup();
  host.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,shiftKey:true,clientX:15,clientY:45}));
  document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,button:0,shiftKey:true,clientX:15,clientY:45}));
  expect(data).not.toHaveBeenCalled();
  host.dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0,clientX:15,clientY:45}));
  document.dispatchEvent(new MouseEvent("mouseup",{bubbles:true,button:0,shiftKey:true,clientX:15,clientY:45}));
  expect(data).toHaveBeenCalledTimes(2);
});
