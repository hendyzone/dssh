import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampConnectionTabScroll,
  tabStripScrollLeftAfterWheel,
} from "../src/lib/connectionTabScroll";

describe("tabStripScrollLeftAfterWheel", () => {
  it("clamps wheel delta to scroll range", () => {
    expect(tabStripScrollLeftAfterWheel(10, 5, 1, 100)).toBe(15);
    expect(tabStripScrollLeftAfterWheel(0, -50, 1, 100)).toBe(0);
    expect(tabStripScrollLeftAfterWheel(95, 50, 1, 100)).toBe(100);
  });
});

describe("clampConnectionTabScroll", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("pulls scrollLeft back when the first tab crosses the left inset", () => {
    const scroller = document.createElement("div");
    scroller.className = "connection-tab-scroll";
    scroller.style.paddingLeft = "8px";
    const first = document.createElement("div");
    first.className = "tab";
    scroller.append(first);
    document.body.append(scroller);
    Object.defineProperty(scroller, "scrollWidth", { value: 500, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 200, configurable: true });
    let scrollLeft = 30;
    Object.defineProperty(scroller, "scrollLeft", {
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = value;
      },
      configurable: true,
    });

    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
      new DOMRect(100, 0, 200, 32),
    );
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(
      new DOMRect(95, 0, 80, 28),
    );
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      paddingLeft: "8px",
      paddingRight: "0px",
    } as CSSStyleDeclaration);

    clampConnectionTabScroll(scroller);
    expect(scrollLeft).toBe(17);
  });

  it("is a no-op when tabs already fit inside the scrollport", () => {
    const scroller = document.createElement("div");
    scroller.className = "connection-tab-scroll";
    const tab = document.createElement("div");
    tab.className = "tab";
    scroller.append(tab);
    document.body.append(scroller);
    Object.defineProperty(scroller, "scrollWidth", { value: 120, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 200, configurable: true });
    scroller.scrollLeft = 0;

    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 200, 32),
    );
    vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(
      new DOMRect(8, 0, 80, 28),
    );

    clampConnectionTabScroll(scroller);
    expect(scroller.scrollLeft).toBe(0);
  });

  it("mutation: without correction first-tab overlap would remain", () => {
    const scroller = document.createElement("div");
    scroller.className = "connection-tab-scroll";
    scroller.style.paddingLeft = "8px";
    const tab = document.createElement("div");
    tab.className = "tab";
    scroller.append(tab);
    document.body.append(scroller);
    Object.defineProperty(scroller, "scrollWidth", { value: 400, configurable: true });
    Object.defineProperty(scroller, "clientWidth", { value: 200, configurable: true });
    scroller.scrollLeft = 25;

    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue(
      new DOMRect(50, 0, 200, 32),
    );
    vi.spyOn(tab, "getBoundingClientRect").mockReturnValue(
      new DOMRect(40, 0, 80, 28),
    );

    const before = scroller.scrollLeft;
    clampConnectionTabScroll(scroller);
    expect(scroller.scrollLeft).toBeLessThan(before);
  });
});
