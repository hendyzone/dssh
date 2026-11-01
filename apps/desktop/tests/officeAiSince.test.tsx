import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import TeamOffice from "../src/components/TeamOffice";
import type { OfficeMember, OfficeSnapshot } from "../src/lib/teamOffice";
import { serviceAi } from "../src/lib/serviceAi";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ai = (updatedMinsAgo: number, sinceMinsAgo?: number) => serviceAi({
  status: "working", summary: "已完成 T32b", evidence: "fixture", model: "example-model",
  updatedAt: iso(updatedMinsAgo * 60_000),
  ...(sinceMinsAgo === undefined ? {} : {since: iso(sinceMinsAgo * 60_000)}),
});
const snapshot = (member: OfficeMember): OfficeSnapshot => ({
  version: 1, themeId: "one-light", animationEnabled: false, mailAvailability: "unavailable",
  projects: [{id: "example", name: "Example", sources: [{id: "source", label: "Example", availability: "ready", notice: "", members: [member]}]}],
});
const station = (view: ReturnType<typeof render>) => view.container.querySelector("[data-member-id]")!;

// T89：气泡时间用「摘要所述状态成立时刻」since，而不是摘要刷新时刻 updatedAt。
it("shows the since time and treats an old since as old even when the summary was just refreshed", () => {
  const member: OfficeMember = {
    id: "w", name: "worker", isLead: false, paletteKey: "w",
    status: {state: "working", source: "program", label: "工作中"},
    taskSource: "none", taskText: "暂无当前任务",
    ai: ai(1, 5 * 60), // 1 分钟前刚重写，但这句摘要 5 小时前就成立
  };
  const view = render(<TeamOffice snapshot={snapshot(member)}/>);
  const node = station(view);
  expect(node.querySelector(".office-ai-bubble small")?.textContent).toBe("5 小时前");
  expect(node.querySelector(".office-ai-bubble")?.getAttribute("title")).toContain("5 小时前");
  expect(node.querySelector(".office-ai-bubble")?.classList.contains("is-old")).toBe(true);
});

it("falls back to updatedAt when an old service sends no since", () => {
  const member: OfficeMember = {
    id: "w", name: "worker", isLead: false, paletteKey: "w",
    status: {state: "working", source: "program", label: "工作中"},
    taskSource: "none", taskText: "暂无当前任务",
    ai: ai(2 * 60), // 旧服务端：只有 updatedAt
  };
  expect(member.ai?.since).toBeUndefined();
  const view = render(<TeamOffice snapshot={snapshot(member)}/>);
  const node = station(view);
  expect(node.querySelector(".office-ai-bubble small")?.textContent).toBe("2 小时前");
  expect(node.querySelector(".office-ai-bubble")?.classList.contains("is-old")).toBe(true);
});

it("does not mark a fresh since as old because updatedAt is old", () => {
  const member: OfficeMember = {
    id: "w", name: "worker", isLead: false, paletteKey: "w",
    status: {state: "working", source: "program", label: "工作中"},
    taskSource: "none", taskText: "暂无当前任务",
    ai: ai(3 * 60, 1), // 摘要 3 小时前生成，但当前状态 1 分钟前才成立
  };
  const view = render(<TeamOffice snapshot={snapshot(member)}/>);
  const node = station(view);
  expect(node.querySelector(".office-ai-bubble small")?.textContent).toBe("1 分钟前");
  expect(node.querySelector(".office-ai-bubble")?.classList.contains("is-old")).toBe(false);
});
