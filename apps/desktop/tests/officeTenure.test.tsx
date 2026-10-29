import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import TeamOffice, { fitOfficeGrid } from "../src/components/TeamOffice";
import { buildOfficeSnapshot, parseForTask, type OfficeMember, type OfficeSnapshot } from "../src/lib/teamOffice";
import { emptyProfile } from "../src/lib/collaboration";

const member = (id: string, extra: Partial<OfficeMember> = {}): OfficeMember => ({
  id, name: id, isLead: false, paletteKey: `key-${id}`, status: {state: "working", source: "program", label: "工作中"},
  taskSource: "manual", taskText: `任务 ${id}`, tenure: "resident", tool: "codex", ...extra,
});
const snapshot = (members: OfficeMember[]): OfficeSnapshot => ({
  version: 1, themeId: "one-light", animationEnabled: false, mailAvailability: "unavailable",
  projects: [{id: "example", name: "Example", sources: [{id: "source", label: "Example", availability: "ready", notice: "", members}]}],
});
const ids = (container: HTMLElement) => Array.from(container.querySelectorAll("[data-member-id]")).map(node => node.getAttribute("data-member-id"));
afterEach(() => localStorage.clear());

it("keeps resident stations at stable positions when the member array order changes", () => {
  const residents = [member("alpha"), member("beta"), member("lead", {isLead: true})];
  const first = render(<TeamOffice snapshot={snapshot(residents)}/>);
  const second = render(<TeamOffice snapshot={snapshot([...residents].reverse())}/>);
  expect(ids(first.container)).toEqual(["lead", "alpha", "beta"]);
  expect(ids(second.container)).toEqual(["lead", "alpha", "beta"]);
  expect(first.container.querySelectorAll(".office-temp-zone")).toHaveLength(0);
});

it("puts temporary workers in their own zone and names the card they were opened for", () => {
  const view = render(<TeamOffice snapshot={snapshot([
    member("resident"),
    member("temp-a", {tenure: "temporary", forTask: "alpha/T62"}),
  ])}/>);
  const main = view.container.querySelector(".office-desks")!;
  expect(Array.from(main.querySelectorAll("[data-member-id]")).map(node => node.getAttribute("data-member-id"))).toEqual(["resident"]);
  const zone = view.container.querySelector(".office-temp-zone")!;
  expect(zone).toBeTruthy();
  expect(zone.getAttribute("aria-label")).toBe("临时工位");
  const station = zone.querySelector('[data-member-id="temp-a"]')!;
  expect(station.getAttribute("data-tenure")).toBe("temporary");
  expect(station.getAttribute("data-for-task")).toBe("alpha/T62");
  // 区头只写「临时工位」，不写解说句；工牌不再挂重复的「临时」徽标。
  expect(zone.querySelector(".office-temp-heading")!.textContent).toBe("◷ 临时工位");
  expect(station.querySelector(".office-tenure-badge")).toBeNull();
  // 卡片号单独等宽显示，不再写「为 … 而开」。
  const task = station.querySelector(".office-temp-task")!;
  expect(task.textContent).toBe("alpha/T62");
  expect(station.textContent).not.toContain("而开");
  expect(station.querySelector(".office-detail")?.textContent).toContain("工位：临时");
  // 名字完整可读，不被徽标挤掉
  expect(station.querySelector(".office-station-name strong")?.textContent).toBe("temp-a");
});

it("marks a temporary worker whose card is already done as 待回收 with the card number", () => {
  const done = render(<TeamOffice snapshot={snapshot([
    member("temp-done", {tenure: "temporary", forTask: "alpha/T61", forTaskDone: true}),
  ])}/>);
  const station = done.container.querySelector('[data-member-id="temp-done"]')!;
  expect(station.getAttribute("data-for-task-done")).toBe("true");
  const badge = station.querySelector(".office-reclaim-badge")!;
  expect(badge.textContent).toBe("待回收");
  expect(badge.getAttribute("title")).toBe("alpha/T61 · 已完成");
  expect(station.querySelector(".office-detail")?.textContent).toContain("待回收");

  // 状态未知（查不到卡）时不猜待回收，卡号照常显示
  done.unmount();
  const unknown = render(<TeamOffice snapshot={snapshot([
    member("temp-open", {tenure: "temporary", forTask: "alpha/T60"}),
  ])}/>);
  const open = unknown.container.querySelector('[data-member-id="temp-open"]')!;
  expect(open.querySelector(".office-reclaim-badge")).toBeNull();
  expect(open.textContent).toContain("alpha/T60");
  expect(open.getAttribute("data-for-task-done")).toBe("");
});

it("treats a missing tenure as resident without guessing from notes", () => {
  const missing = member("legacy", {notes: "临时 帮个忙"});
  delete missing.tenure;
  const view = render(<TeamOffice snapshot={snapshot([missing])}/>);
  const station = view.container.querySelector('[data-member-id="legacy"]')!;
  expect(station.getAttribute("data-tenure")).toBe("resident");
  expect(view.container.querySelector(".office-temp-zone")).toBeNull();
  expect(station.querySelector(".office-reclaim-badge")).toBeNull();
});

it("reserves height for temporary zone headers so small rooms still fit", () => {
  const plain = fitOfficeGrid(2, 3000, 3000, false, [2], 0);
  const withTemp = fitOfficeGrid(2, 3000, 3000, false, [2], 1);
  expect(withTemp.scale).toBe(plain.scale);
  expect(withTemp.columns).toBe(plain.columns);
  expect(withTemp.height - plain.height).toBeGreaterThan(0);
});

it("carries tenure and for_task from the roster into the snapshot and only marks done from the board lookup", () => {
  const target = {id: "source", project: "alpha", label: "alpha", profile: emptyProfile(), service: true};
  const rosterMember = {
    project: "alpha", email: "temp@example.invalid", role: "Worker", host: "host-a", port: 22,
    username: "dev", workdir: "/srv/alpha", tmux: {id: "$9", created: 42, name: "worker"},
    tenure: "temporary", for_task: "alpha/T62",
  };
  const rosters = {
    source: {availability: "ready" as const, notice: "", members: [rosterMember]},
  };
  const base = {servers: [], sessions: [], themeId: "one-light", animationEnabled: false};
  const unknown = buildOfficeSnapshot([target], rosters as never, {...base, boards: {}});
  const office = unknown.projects[0].sources[0].members[0];
  expect(office.tenure).toBe("temporary");
  expect(office.forTask).toBe("alpha/T62");
  expect(office.forTaskDone).toBeUndefined();

  const done = buildOfficeSnapshot([target], rosters as never, {...base, boards: {source: {briefs: {}, offline: false, forTasks: {"alpha/T62": "done"}}}});
  expect(done.projects[0].sources[0].members[0].forTaskDone).toBe(true);

  // 缺字段 = 常驻；for_task 格式不对不带出
  const plain = {...rosterMember, tenure: undefined, for_task: "not a card"};
  const legacy = buildOfficeSnapshot([target], {source: {availability: "ready", notice: "", members: [plain]}} as never, {...base, boards: {}});
  expect(legacy.projects[0].sources[0].members[0].tenure).toBe("resident");
  expect(legacy.projects[0].sources[0].members[0].forTask).toBeUndefined();
  expect(parseForTask("alpha/T62")).toEqual({project: "alpha", code: "T62"});
  expect(parseForTask("alpha")).toBeUndefined();
});
