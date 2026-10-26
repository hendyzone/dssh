import { render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import TeamOffice from "../src/components/TeamOffice";
import type { OfficeMember, OfficeSnapshot } from "../src/lib/teamOffice";
const member = (id: string, state: OfficeMember["status"]["state"], extra: Partial<OfficeMember> = {}): OfficeMember => ({
  id, name: id, isLead: false, paletteKey: id, status: {state, source: "program", label: state},
  taskSource: "manual", taskText: `Task for ${id}`, tool: "codex", machine: `machine-${id}`,
  ...extra,
});
const ai = (minutes: number) => ({status: "working" as const, summary: "A short summary", evidence: "Fixture evidence", model: "example-model", updatedAt: new Date(Date.now()-minutes*60_000).toISOString()});
const snapshot = (members: OfficeMember[], state: "online" | "offline" | "error" = "online"): OfficeSnapshot => ({
  version: 1, themeId: "one-light", animationEnabled: false, mailAvailability: "unavailable", service: {state},
  projects: [{id: "example", name: "Example", sources: [{id: "source", label: "Example", availability: "ready", notice: "", members}]}],
});
afterEach(() => localStorage.clear());
it("orders Lead first then stuck, waiting, working, idle and offline without reordering ties", () => {
  const view = render(<TeamOffice snapshot={snapshot([
    member("idle", "idle"), member("worker-a", "working"), member("offline", "unknown", {machineOnline: false}),
    member("waiting", "blocked"), member("worker-b", "working"), member("lead", "idle", {isLead: true}), member("stuck", "error"),
  ])}/>);
  expect(Array.from(view.container.querySelectorAll("[data-member-id]")).map(node => node.getAttribute("data-member-id"))).toEqual(["lead", "stuck", "waiting", "worker-a", "worker-b", "idle", "offline"]);
});
it("dims idle/offline stations and hides their task and old AI while retaining urgent AI", () => {
  const view = render(<TeamOffice snapshot={snapshot([
    member("idle", "idle", {ai: ai(31)}), member("offline", "unknown", {machineOnline: false, ai: ai(31)}),
    member("recent", "idle", {ai: ai(1)}), member("working", "working", {ai: ai(31)}),
    member("waiting", "blocked", {ai: ai(31)}), member("stuck", "error", {ai: ai(31)}),
  ])}/>);
  for (const id of ["idle", "offline", "recent"]) {
    const station = view.container.querySelector(`[data-member-id="${id}"]`)!;
    expect(station.classList.contains("is-quiet")).toBe(true);
    expect(station.querySelector(".office-member-task")).toBeNull();
    expect(station.querySelector(".office-ai-bubble") !== null).toBe(id === "recent");
  }
  for (const id of ["working", "waiting", "stuck"]) {
    const station = view.container.querySelector(`[data-member-id="${id}"]`)!;
    expect(station.classList.contains("is-quiet")).toBe(false);
    expect(station.querySelector(".office-member-task")).toBeTruthy();
    expect(station.querySelector(".office-ai-bubble")).toBeTruthy();
  }
  expect(readFileSync(`${process.cwd()}/src/components/TeamOffice.css`, "utf8")).toMatch(/\.office-station\.is-quiet\s*\{[^}]*opacity\s*:\s*\.55/);
});
it("keeps tools on nameplates and machine information only in the detail card", () => {
  const view = render(<TeamOffice snapshot={snapshot([member("worker", "working")])}/>);
  const station = view.container.querySelector(".office-station")!;
  expect(station.querySelector(".office-tool")?.textContent).toBe("CX");
  expect(station.querySelector(".office-desk-label")?.textContent).not.toContain("machine-worker");
  expect(station.querySelector(".office-member-machine")).toBeNull();
  expect(station.querySelector(".office-detail")?.textContent).toContain("machine-worker");
});
it("uses a thin summary header without duplicate title or online subtitle and only warns when unavailable", () => {
  const view = render(<TeamOffice snapshot={snapshot([member("worker", "working")])}/>);
  const header = view.container.querySelector(".office-toolbar")!;
  expect(header.textContent).not.toContain("公司办公室");
  expect(header.textContent).toContain("工作中 1");
  expect(view.container.querySelector(".office-coverage")).toBeNull();
  expect(screen.queryByText(/数据来自团队服务的订阅项目/)).toBeNull();
  const counts = view.container.querySelector(".office-project-counts")!;
  expect(counts.textContent).toContain("运行中 1");
  expect(counts.textContent).not.toMatch(/卡住 0|等待 0|空闲 0|离线 0/);
  view.rerender(<TeamOffice snapshot={snapshot([member("worker", "working")], "offline")}/>);
  expect(view.container.querySelector(".office-coverage")?.textContent).toContain("离线");
  view.rerender(<TeamOffice snapshot={snapshot([member("worker", "working")], "error")}/>);
  expect(view.container.querySelector(".office-coverage")?.textContent).toContain("不可用");
});
