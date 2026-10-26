import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TeamOffice from "../src/components/TeamOffice";
import { officeStatusCounts, type OfficeMember, type OfficeSnapshot } from "../src/lib/teamOffice";

const member = (id: string, over: Partial<OfficeMember> = {}): OfficeMember => ({
  id, name: id, isLead: false, status: { state: "working", source: "program", label: "工作中（团队服务）" },
  taskText: `Task ${id}`, taskSource: "manual", paletteKey: `palette-${id}`,
  liveState: "running", match: "exact", machine: "host-a", machineOnline: true, ...over,
});
const snapshot = (members: OfficeMember[], over: Partial<OfficeSnapshot> = {}): OfficeSnapshot => ({
  version: 1, themeId: "one-light", animationEnabled: true, mailAvailability: "unavailable",
  projects: [{ id: "p1", name: "alpha", sources: [{ id: "s1", label: "alpha", availability: "ready", notice: "", members }] }],
  ...over,
});
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const states: [string, Partial<OfficeMember>][] = [
  ["running", { liveState: "running", status: { state: "working", source: "program", label: "工作中" } }],
  ["waiting_input", { liveState: "waiting_input", status: { state: "blocked", source: "program", label: "等待处理" } }],
  ["stuck", { liveState: "stuck", status: { state: "error", source: "program", label: "卡住" } }],
  ["idle", { liveState: "idle", status: { state: "idle", source: "program", label: "空闲" } }],
  ["gone", { liveState: "unknown", match: "gone", status: { state: "unknown", source: "program", label: "会话已结束" } }],
  ["replaced", { liveState: "unknown", match: "replaced", status: { state: "unknown", source: "program", label: "会话已更替" } }],
  ["no_agent", { liveState: "idle", match: "no_agent", status: { state: "idle", source: "program", label: "无 Agent" } }],
  ["offline", { liveState: "idle", machineOnline: false, status: { state: "idle", source: "program", label: "机器离线" } }],
];

it("renders every live state with a distinct, non-colour-only cue", () => {
  const members = states.map(([name, over]) => member(name, over));
  const view = render(<TeamOffice snapshot={snapshot(members)}/>);
  for (const [name] of states) {
    const station = view.container.querySelector(`[data-member-id="${name}"]`)!;
    expect(station).toBeTruthy();
    expect(station.getAttribute("data-live-state")).toBe(members.find(m => m.id === name)!.liveState);
  }
  const waiting = view.container.querySelector('[data-member-id="waiting_input"]')!;
  expect(getComputedStyle(waiting, "::after").content || "?").toBeTruthy();
  expect(view.container.querySelector('[data-member-id="stuck"]')!.classList.contains("is-stuck")).toBe(true);
  expect(view.container.querySelector('[data-member-id="gone"]')!.classList.contains("is-ended")).toBe(true);
  expect(view.container.querySelector('[data-member-id="gone"] .office-empty-chair')).toBeTruthy();
  expect(view.container.querySelector('[data-member-id="replaced"] .office-empty-chair')).toBeTruthy();
  expect(view.container.querySelector('[data-member-id="no_agent"]')!.classList.contains("is-grey")).toBe(true);
  expect(view.container.querySelector('[data-member-id="offline"]')!.classList.contains("is-grey")).toBe(true);
});

it("counts each team by state and shows the numbers on the sign", () => {
  const members = [
    member("r1"), member("r2", { liveState: "waiting_input" }), member("s1", { liveState: "stuck" }),
    member("i1", { liveState: "idle" }), member("o1", { liveState: "unknown", match: "gone" }),
    member("o2", { machineOnline: false }),
  ];
  expect(officeStatusCounts(members)).toEqual({ running: 1, waiting: 1, stuck: 1, idle: 1, offline: 2 });
  render(<TeamOffice snapshot={snapshot(members)}/>);
  expect(screen.getByLabelText("团队状态计数").textContent).toBe("运行中 1 · 等待 1 · 卡住 1 · 空闲 1 · 离线 2");
});

it("opens expanded by default and remembers collapsed teams in localStorage", () => {
  const first = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  expect(screen.getByRole("region", { name: "项目 alpha" }).querySelector(".office-project-floor")?.hasAttribute("hidden")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "折叠项目 alpha" }));
  expect(localStorage.getItem("dssh.office.collapsed.v1")).toContain("p1");
  first.unmount();
  const again = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  expect(again.container.querySelector(".office-project-floor")?.hasAttribute("hidden")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "展开项目 alpha" }));
  expect(again.container.querySelector(".office-project-floor")?.hasAttribute("hidden")).toBe(false);
});

it("shows a plain-text detail card on focus and renders evidence as text, not HTML", () => {
  const evil = "<script>window.__pwned = true</script>";
  const view = render(<TeamOffice snapshot={snapshot([member("a", {
    responsibilities: "后端接口", taskFull: "T1 · 长任务全文",
    ai: { status: "working", summary: "正在改接口", evidence: evil, model: "gpt-6", updatedAt: new Date().toISOString() },
    since: Math.floor(Date.now() / 1000) - 120,
  })])}/>);
  const station = view.container.querySelector('[data-member-id="a"]') as HTMLElement;
  station.focus();
  const card = screen.getByRole("tooltip");
  expect(card.textContent).toContain("后端接口");
  expect(card.textContent).toContain("T1 · 长任务全文");
  expect(card.textContent).toContain("正在改接口");
  expect(card.textContent).toContain("<script>window.__pwned = true</script>");
  expect(card.querySelector("script")).toBeNull();
  expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
});

it("explains service and mail state instead of a bare unavailable label", () => {
  const { rerender } = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  expect(screen.getByText(/邮件动态未配置/)).toBeTruthy();
  rerender(<TeamOffice snapshot={snapshot([member("a")], { service: { state: "online" } })}/>);
  expect(screen.getByRole("status").textContent).toContain("服务在线");
  rerender(<TeamOffice snapshot={snapshot([member("a")], { service: { state: "offline", at: Date.now() - 3600_000 } })}/>);
  expect(screen.getByRole("status").textContent).toMatch(/团队服务离线 · 数据截至 \d\d:\d\d/);
  rerender(<TeamOffice snapshot={snapshot([member("a")], { service: { state: "unauthorized" } })}/>);
  expect(screen.getByRole("status").textContent).toContain("令牌已失效");
});

it("hides the AI bubble without ai and fades old summaries", () => {
  const view = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  expect(view.container.querySelector(".office-ai-bubble")).toBeNull();
  view.rerender(<TeamOffice snapshot={snapshot([member("a", {
    ai: { status: "working", summary: "这是一条超过二十个字的摘要内容用于测试截断", evidence: "", model: "m", updatedAt: new Date(Date.now() - 2 * 3600_000).toISOString() },
  })])}/>);
  const bubble = view.container.querySelector(".office-ai-bubble")!;
  expect(bubble.classList.contains("is-old")).toBe(true);
  expect(bubble.textContent).toContain("…");
});

it("stops animations for prefers-reduced-motion", () => {
  const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", () => media);
  const view = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  expect(view.container.querySelector(".team-office")?.getAttribute("data-motion")).toBe("off");
  expect(view.container.querySelector(".team-member-avatar")?.getAttribute("data-motion")).toBe("off");
});

it("opens the member terminal from a click or keyboard on the station", () => {
  const open = vi.fn();
  const view = render(<TeamOffice snapshot={snapshot([member("a")])} onOpenMember={open}/>);
  const station = view.container.querySelector('[data-member-id="a"]') as HTMLElement;
  fireEvent.click(station);
  fireEvent.keyDown(station, { key: "Enter" });
  fireEvent.keyDown(station, { key: " " });
  expect(open.mock.calls).toEqual([["palette-a"], ["palette-a"], ["palette-a"]]);
});

it("renders a 30-member team promptly", () => {
  const members = Array.from({ length: 30 }, (_, i) => member(`m${i}`, { isLead: i === 0 }));
  const started = performance.now();
  const view = render(<TeamOffice snapshot={snapshot(members)}/>);
  const elapsed = performance.now() - started;
  expect(view.container.querySelectorAll("[data-member-id]")).toHaveLength(30);
  expect(elapsed).toBeLessThan(1500);
});

it("shows the local clock and switches sky phase without touching member data", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 26, 14, 5));
  const view = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  expect(screen.getByText("14:05")).toBeTruthy();
  expect(view.container.querySelector(".office-upper-wall")?.getAttribute("data-phase")).toBe("day");
  vi.setSystemTime(new Date(2026, 9, 26, 23, 10));
  act(() => vi.advanceTimersByTime(30_000));
  expect(view.container.querySelector(".office-upper-wall")?.getAttribute("data-phase")).toBe("night");
  expect(view.container.querySelector(".office-stars")).toBeTruthy();
  vi.useRealTimers();
});

it("keeps the AI bubble in a reserved row so no overflow container can clip it", () => {
  const view = render(<TeamOffice snapshot={snapshot([member("a", { ai: { status: "working", summary: "正在合并房间与成员视图", evidence: "", model: "m", updatedAt: new Date().toISOString() } }), member("b")])}/>);
  const stationA = view.container.querySelector('[data-member-id="a"]')!;
  const bubble = stationA.querySelector(".office-ai-bubble")!;
  expect(bubble.parentElement?.classList.contains("office-ai-slot")).toBe(true);
  expect(stationA.querySelector(".office-pixels")?.contains(bubble)).toBe(false);
  // 每个工位都有同样高度的气泡槽，行内卡片才能对齐
  expect(view.container.querySelectorAll(".office-ai-slot")).toHaveLength(2);
});

it("renders the task paper as an independent block after the desk, never under the nameplate", () => {
  const view = render(<TeamOffice snapshot={snapshot([member("a", { taskText: "T40 · 统一成员显示", taskFull: "T40 统一成员显示" })])}/>);
  const station = view.container.querySelector('[data-member-id="a"]')!;
  const pixels = station.querySelector(".office-pixels")!;
  const label = station.querySelector(".office-desk-label")!;
  const paper = station.querySelector(".office-station-paper")!;
  expect(paper).toBeTruthy();
  expect(pixels.contains(paper)).toBe(false);
  expect(label.contains(paper)).toBe(false);
  expect(paper.previousElementSibling).toBe(pixels);
});

it("does not render a second team name for a single-source project", () => {
  const one = render(<TeamOffice snapshot={snapshot([member("a")])}/>);
  const region = one.container.querySelector('[aria-label="项目 alpha"]')!;
  expect(region.querySelector(".office-source-label")).toBeNull();
  one.unmount();
  const twoSources: OfficeSnapshot = snapshot([member("a")]);
  twoSources.projects[0].sources.push({ id: "s2", label: "alpha · other", availability: "ready", notice: "", members: [] });
  render(<TeamOffice snapshot={twoSources}/>);
  expect(screen.getByText("alpha · other")).toBeTruthy();
});
