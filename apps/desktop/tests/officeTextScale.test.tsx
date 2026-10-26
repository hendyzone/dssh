import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import TeamOffice, { fitOfficeGrid } from "../src/components/TeamOffice";
import type { OfficeSnapshot } from "../src/lib/teamOffice";

const SCALE_KEY = "dssh.office.scale.v1";
const room = (count = 9): OfficeSnapshot => ({
  version: 1, themeId: "one-light", animationEnabled: false, mailAvailability: "unavailable",
  projects: [{id: "example", name: "Example", sources: [{id: "source", label: "Example", availability: "ready", notice: "", members: Array.from({length: count}, (_, index) => ({
    id: `member-${index}`, name: `worker-with-a-long-name-${index}`, isLead: index === 0, paletteKey: `member-${index}`,
    status: {state: "working", source: "program", label: "工作中"}, tool: "codex", machine: "host-a",
    taskText: "T1 A long current task that takes more than one line", taskSource: "manual",
  }))}]}],
});
let width = 1077;
let height = 527;
const observations: {callback: ResizeObserverCallback; target?: Element; disconnect: ReturnType<typeof vi.fn>}[] = [];
beforeEach(() => {
  localStorage.clear(); observations.length = 0; width = 1077; height = 527;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function () {return this.classList.contains("office-projects") ? width : 0;});
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {return this.classList.contains("office-projects") ? height : 0;});
  vi.stubGlobal("ResizeObserver", class {
    entry: typeof observations[number];
    constructor(callback: ResizeObserverCallback) {this.entry = {callback, disconnect: vi.fn()}; observations.push(this.entry);}
    observe(target: Element) {this.entry.target = target;}
    unobserve() {}
    disconnect() {this.entry.disconnect();}
  });
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear();});
function resize(w: number, h: number) {
  width = w; height = h;
  act(() => {for (const observer of observations) if (observer.target?.classList.contains("office-projects")) observer.callback([{target: observer.target, contentRect: {width, height}} as ResizeObserverEntry], {} as ResizeObserver);});
}
it("defaults to adaptive sizing and responds to the remaining visible room geometry", () => {
  const view = render(<TeamOffice snapshot={room()}/>);
  const root = screen.getByRole("region", {name: "公司办公室"});
  const select = screen.getByRole("combobox", {name: "房间像素缩放"});
  expect(within(select).getAllByRole("option").map(option => option.getAttribute("value"))).toEqual(["auto", "1", "2", "3"]);
  expect((select as HTMLSelectElement).value).toBe("auto");
  // Exercise the actual RO consumer with window size and remaining room size separately.
  for (const [viewportW, viewportH] of [[1097,617], [1920,1080], [1280,720]]) {
    vi.stubGlobal("innerHeight", viewportH);
    vi.stubGlobal("innerWidth", viewportW);
    resize(viewportW - 20, viewportH - 90);
    const scale = Number(root.getAttribute("data-scale"));
    expect(scale).toBeGreaterThanOrEqual(1);
    expect(scale).toBeLessThanOrEqual(3);
    expect(scale * 4).toBe(Math.round(scale * 4));
    expect(root.getAttribute("data-scale-mode")).toBe("auto");
    expect(Number(root.getAttribute("data-columns")) * Number(root.getAttribute("data-rows"))).toBeGreaterThanOrEqual(9);
    expect(Number(root.style.getPropertyValue("--office-text"))).toBeCloseTo(1 + (scale - 1) * 0.15);
  }
  vi.stubGlobal("innerHeight", 890);
  resize(4000,800);
  expect(root.getAttribute("data-scale")).toBe("3");
  expect(root.getAttribute("data-columns")).not.toBe("3");
  view.unmount();
  expect(observations.filter(observer => observer.target?.classList.contains("office-projects")).every(observer => observer.disconnect.mock.calls.length === 1)).toBe(true);
});
it("sets the text multiplier for each explicit scale and persists manual selection across resize and remount", () => {
  const view = render(<TeamOffice snapshot={room()}/>);
  const root = screen.getByRole("region", {name: "公司办公室"});
  for (const [scale, multiplier] of [[1,1], [2,1.15], [3,1.3]]) {
    fireEvent.change(screen.getByRole("combobox", {name: "房间像素缩放"}), {target: {value: String(scale)}});
    expect(root.style.getPropertyValue("--office-text")).toBe(String(multiplier));
    expect(localStorage.getItem(SCALE_KEY)).toBe(String(scale));
    resize(780,410);
    expect(root.getAttribute("data-scale")).toBe(String(scale));
  }
  view.unmount();
  render(<TeamOffice snapshot={room()}/>);
  expect(screen.getByRole("region", {name: "公司办公室"}).getAttribute("data-scale-mode")).toBe("3");
  fireEvent.change(screen.getByRole("combobox", {name: "房间像素缩放"}), {target: {value: "auto"}});
  expect(localStorage.getItem(SCALE_KEY)).toBe("auto");
  expect(screen.getByRole("region", {name: "公司办公室"}).getAttribute("data-scale-mode")).toBe("auto");
});
it("survives unavailable storage and compacts the wall below 520 pixels of visible room height", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {throw new Error("Unavailable");});
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {throw new Error("Unavailable");});
  render(<TeamOffice snapshot={room()}/>);
  const root = screen.getByRole("region", {name: "公司办公室"});
  fireEvent.change(screen.getByRole("combobox", {name: "房间像素缩放"}), {target: {value: "2"}});
  expect(root.style.getPropertyValue("--office-text")).toBe("1.15");
  resize(1077,519); expect(root.getAttribute("data-compact-wall")).toBe("true");
  resize(1077,520); expect(root.getAttribute("data-compact-wall")).toBe("false");
});
it("keeps station labels in normal flow and scales office typography without sub-11px base sizes", () => {
  const css = readFileSync(`${process.cwd()}/src/components/TeamOffice.css`, "utf8");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const scanned: string[] = [];
  for (const [, selector, body] of rules) {
    if (!selector.includes(".office-") || selector.includes(".office-toolbar") || body.includes("--mail-scale")) continue;
    for (const match of body.matchAll(/font-size\s*:\s*([^;]+)/g)) {
      const value = match[1].trim();
      const bare = value.match(/^(\d+(?:\.\d+)?)px$/);
      if (bare) expect(Number(bare[1]), selector).toBeGreaterThanOrEqual(11);
      const scaled = value.match(/^calc\((\d+(?:\.\d+)?)px\s*\*\s*var\(--office-text,\s*1\)\)$/);
      if (scaled) {expect(Number(scaled[1]), selector).toBeGreaterThanOrEqual(11); scanned.push(selector);}
    }
    if (selector.split(",").some(item => item.trim() === ".office-desk-label")) expect(body).not.toMatch(/position\s*:\s*absolute/);
  }
  expect(scanned.some(selector => selector.includes(".office-station-name strong"))).toBe(true);
  expect(scanned.some(selector => selector.includes(".office-member-task"))).toBe(true);
  expect(scanned.some(selector => selector.includes(".office-ai-bubble"))).toBe(true);
  expect(css).not.toMatch(/max-height\s*:\s*75vh/);
});

it("fits all nine stations within each available grid and chooses the largest scale for small teams", () => {
  for (const [width, height] of [[1097,617], [1920,1080], [1280,720]]) {
    const fit = fitOfficeGrid(9, width, height, true);
    expect(fit.width).toBeLessThanOrEqual(width);
    expect(fit.height).toBeLessThanOrEqual(height);
    expect(fit.rows * fit.columns).toBeGreaterThanOrEqual(9);
    expect(fit.scale * 4).toBe(Math.round(fit.scale * 4));
  }
  expect(fitOfficeGrid(3,1920,900,true).scale).toBe(3);
  const wide = fitOfficeGrid(9,4000,500,true);
  expect(wide.scale).toBe(3);
  expect(wide.columns).not.toBe(3);
});
it("opens only the first project by default and compacts tasks at small scales", () => {
  const value = room(3);
  value.projects[0].sources[0].members[0].ai = {status:"working",summary:"这是一段用于验证小尺寸气泡自动截断字符数的固定摘要",evidence:"",model:"example-model",updatedAt:new Date().toISOString()};
  value.projects.push({...value.projects[0], id: "second", name: "Second"});
  const view = render(<TeamOffice snapshot={value}/>);
  expect(screen.getByRole("button", {name: "折叠项目 Example"}).getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", {name: "展开项目 Second"}).getAttribute("aria-expanded")).toBe("false");
  fireEvent.change(screen.getByRole("combobox", {name: "房间像素缩放"}), {target: {value: "1"}});
  expect(view.container.querySelector('.team-office')?.getAttribute('data-scale')).toBe('1');
  expect(view.container.querySelector('.office-ai-text')?.textContent).toBe('这是一段用于验证小尺寸气泡自动截断字符数的固定摘要'.slice(0,16)+'…');
  const css = readFileSync(`${process.cwd()}/src/components/TeamOffice.css`, "utf8");
  expect(css).toMatch(/-webkit-line-clamp:\s*1/);
});

it("accounts for distinct source rows instead of packing unrelated sources into one row", () => {
  const fit = fitOfficeGrid(9,1920,1080,true,[2,7]);
  expect(fit.rows).toBe(Math.ceil(2/fit.columns)+Math.ceil(7/fit.columns));
  expect(fit.width).toBeLessThanOrEqual(1920);
  expect(fit.height).toBeLessThanOrEqual(1080);
});
