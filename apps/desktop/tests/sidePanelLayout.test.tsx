import { useState } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import IconRail from "../src/components/IconRail";
import SidePanelSettings from "../src/components/SidePanelSettings";
import {
  defaultLayout, normalizeLayout, panelsOnSide, placePanel, railPanels, setPanelHidden, setPanelSide,
  type PanelLayout,
} from "../src/lib/sidePanelLayout";

const drag = (source: HTMLElement, target: HTMLElement, clientY = 0) => {
  const transfer = {effectAllowed: "", dropEffect: "", data: {} as Record<string,string>,
    setData(key: string, value: string) { this.data[key] = value; }, getData(key: string) { return this.data[key] ?? ""; }};
  fireEvent.dragStart(source, {dataTransfer: transfer});
  fireEvent.dragOver(target, {dataTransfer: transfer, clientY});
  fireEvent.drop(target, {dataTransfer: transfer, clientY});
  fireEvent.dragEnd(source, {dataTransfer: transfer});
};

function Harness({ initial }: {initial?: PanelLayout}) {
  const [layout, setLayout] = useState<PanelLayout>(() => initial ?? defaultLayout());
  return <>
    <IconRail side="left" items={railPanels(layout, "left")} active={null}
      onSelect={() => {}} onMove={(id, side, index) => setLayout(placePanel(layout, id, side, index))}/>
    <IconRail side="right" items={railPanels(layout, "right")} active={null}
      onSelect={() => {}} onMove={(id, side, index) => setLayout(placePanel(layout, id, side, index))}/>
    <SidePanelSettings layout={layout} onChange={setLayout}/>
  </>;
}

it("starts from the registry defaults: connections on the left, tools on the right, in order", () => {
  const layout = defaultLayout();
  expect(panelsOnSide(layout, "left").map(item => item.id)).toEqual(["connections"]);
  expect(panelsOnSide(layout, "right").map(item => item.id).slice(0, 3)).toEqual(["sftp", "tmux", "team"]);
});

it("keeps an unknown new panel at the end of its default side and ignores unknown ids", () => {
  const saved = {connections: {side: "right", hidden: false, order: 10}};
  const layout = normalizeLayout(saved);
  expect(layout.connections.side).toBe("right");
  const right = panelsOnSide(layout, "right").map(item => item.id);
  expect(right[0]).toBe("connections");
  expect(right.at(-1)).toBe("collaboration"); // new panels without saved prefs append by default side
  expect(right).not.toContain("nonexistent");
  expect(layout.nonexistent).toBeUndefined();
});

it("reorders inside a rail and moves across rails while keeping the arrows order", () => {
  const layout = defaultLayout();
  const next = placePanel(layout, "sftp", "right", 2);
  expect(panelsOnSide(next, "right").map(item => item.id).slice(0, 3)).toEqual(["tmux", "team", "sftp"]);
  const moved = placePanel(layout, "sftp", "left", 0);
  expect(panelsOnSide(moved, "left").map(item => item.id)).toEqual(["sftp", "connections"]);
  expect(panelsOnSide(moved, "right").map(item => item.id)).not.toContain("sftp");
  // persisted JSON keeps the same arrangement after a reload
  expect(panelsOnSide(normalizeLayout(JSON.parse(JSON.stringify(moved))), "left").map(item => item.id))
    .toEqual(["sftp", "connections"]);
});

it("cannot hide the last visible panel and can restore defaults", () => {
  // Hiding is allowed while other panels stay visible…
  expect(setPanelHidden(defaultLayout(), "connections", true).connections.hidden).toBe(true);
  // …but the last one stays visible.
  const hiddenMany = Object.entries(defaultLayout()).reduce<PanelLayout>((layout, [id]) =>
    id === "tmux" ? layout : setPanelHidden(layout, id, true), defaultLayout());
  expect(visibleIds(hiddenMany)).toEqual(["tmux"]);
  expect(setPanelHidden(hiddenMany, "tmux", true).tmux.hidden).toBe(false);
  // the settings checkbox is disabled exactly for the last visible panel
  render(<SidePanelSettings layout={hiddenMany} onChange={() => {}}/>);
  const remaining = visibleIds(hiddenMany)[0];
  const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
  const boxFor = (id: string) => boxes.find(box => box.getAttribute("aria-label") === `显示 ${labelOf(id)}`)!;
  expect(boxFor(remaining).disabled).toBe(true);
  const others = ["connections", "sftp", "tmux", "team"].filter(id => id !== remaining && !hiddenMany[id].hidden);
  for (const id of others) expect(boxFor(id).disabled).toBe(false);
});

it("settings rows change side, visibility and order, and reach the icon rails", async () => {
  const view = render(<Harness/>);
  // 拖动同一栏内的顺序：把 sftp 拖到 tmux 行上
  const sftpRow = view.container.querySelector('[data-panel-row="sftp"]')!;
  const teamRow = view.container.querySelector('[data-panel-row="team"]')!;
  await act(async () => { drag(sftpRow, teamRow); });
  const rightRail = view.container.querySelector(".icon-rail-right")!;
  expect([...rightRail.querySelectorAll("[data-panel-icon]")].map(node => node.getAttribute("data-panel-icon")).slice(0, 3))
    .toEqual(["tmux", "team", "sftp"]);
  // 当前侧的按钮处于按下态，另一侧普通；切换后按下态跟着走
  const sftpRowNow = () => view.container.querySelector('[data-panel-row="sftp"]')!;
  expect(within(sftpRowNow()).getByRole("button", {name: "右侧"}).getAttribute("aria-pressed")).toBe("true");
  expect(within(sftpRowNow()).getByRole("button", {name: "左侧"}).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(within(sftpRowNow()).getByRole("button", {name: "左侧"}));
  expect(within(sftpRowNow()).getByRole("button", {name: "左侧"}).getAttribute("aria-pressed")).toBe("true");
  expect(within(sftpRowNow()).getByRole("button", {name: "右侧"}).getAttribute("aria-pressed")).toBe("false");
  expect([...view.container.querySelectorAll(".icon-rail-left [data-panel-icon]")].map(node => node.getAttribute("data-panel-icon")))
    .toContain("sftp");
  // 隐藏 sftp：图标消失，恢复默认后回来
  fireEvent.click(within(sftpRow).getByRole("checkbox", {name: "显示 文件 · SFTP"}));
  expect(view.container.querySelector('.icon-rail-left [data-panel-icon="sftp"]')).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "恢复默认"}));
  expect(view.container.querySelector('.icon-rail-right [data-panel-icon="sftp"]')).toBeTruthy();
});

it("cross-rail drag keeps the panel open on its new side and reorders the destination rail", async () => {
  const view = render(<Harness/>);
  const leftRail = view.container.querySelector(".icon-rail-left")!;
  const rightRail = view.container.querySelector(".icon-rail-right")!;
  const connectionsIcon = view.container.querySelector('.icon-rail-left [data-panel-icon="connections"]')!;
  const sftpIcon = view.container.querySelector('.icon-rail-right [data-panel-icon="sftp"]')!;
  // jsdom reports empty rects; give each icon slot a height so the drop index is meaningful.
  const slots = [...view.container.querySelectorAll(".icon-rail-right .icon-rail-slot")];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = Math.max(0, slots.indexOf(this));
    return {top: index * 30, bottom: index * 30 + 30, height: 30, left: 0, right: 30, width: 30, x: 0, y: index * 30, toJSON() {}} as DOMRect;
  });
  await act(async () => { drag(connectionsIcon, sftpIcon, 5); });
  vi.restoreAllMocks();
  expect([...leftRail.querySelectorAll("[data-panel-icon]")].map(node => node.getAttribute("data-panel-icon"))).not.toContain("connections");
  expect([...rightRail.querySelectorAll("[data-panel-icon]")].map(node => node.getAttribute("data-panel-icon")).slice(0, 2))
    .toEqual(["connections", "sftp"]);
  // the settings list mirrors the rails
  const rows = [...view.container.querySelectorAll("[data-panel-row]")].map(node => node.getAttribute("data-panel-row"));
  expect(rows.indexOf("connections")).toBeLessThan(rows.indexOf("sftp"));
});

function visibleIds(layout: PanelLayout) {
  return Object.entries(layout).filter(([, value]) => !value.hidden).map(([id]) => id);
}
function labelOf(id: string) {
  return {sftp: "文件 · SFTP", tmux: "tmux 会话", team: "团队 · 打开成员终端", connections: "服务器与连接"}[id] ?? id;
}

it("uses a server icon and show/hide hints for the connection panel entry", () => {
  const onSelect = vi.fn();
  const options = {side: "left" as const, items: railPanels(defaultLayout(), "left"),
    active: "connections", onSelect, onMove: vi.fn()};
  const view = render(<IconRail {...options}/>);
  const button = screen.getByRole("button", {name: "服务器与连接"});
  expect(button.querySelector("svg.lucide-server")).toBeTruthy();
  expect(button.title).toBe("隐藏连接面板");
  fireEvent.click(button);
  expect(onSelect).toHaveBeenCalledWith("connections");
  view.rerender(<IconRail {...options} active={null}/>);
  expect(button.title).toBe("显示连接面板");
});
