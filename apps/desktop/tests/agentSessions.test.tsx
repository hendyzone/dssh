import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import TeamDynamics from "../src/components/TeamDynamics";
import TeamMembers from "../src/components/TeamMembers";
import { briefTargets, isLeadMember, liveSnapshot, liveStatus, matchSession, normalizeHost, noteFreshness, parseAgentSessions, rankMembers, rosterStatus, summarizeTeam } from "../src/lib/agentSessions";
import { emptyProfile } from "../src/lib/collaboration";
import { boardSource, clearBoardCache, defaultLookupSettings } from "../src/lib/taskLookup";
import type { TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

/** Shape of `GET /api/v1/agent-sessions` (taskboard collector), values made up. */
const NOW = 1_792_245_334;
const row = (session: string, extra: Record<string, unknown> = {}) => ({
  host: "cowork1", session, box: session.replace(/^worker-/, ""), tool: "codex", project: "demo",
  task_code: "", bind_via: "", state: "idle", state_detail: "", state_since: NOW - 3600, host_ok: true, stale: false,
  first_seen: NOW - 86400, seen_at: NOW - 24, worktree: `/work/.worktrees/${session.replace(/^worker-/, "")}`, branch: "main",
  commit_hash: "a279fa74", commit_time: NOW - 7200, commit_subject: "chore: something", dirty: 0, last_line: "", activity_at: NOW - 3600,
  ...extra,
});
const payload = (sessions: unknown[]) => ({ sessions, now: NOW, ttl_seconds: 180, alert_after_seconds: 600, last_collected_at: NOW - 24 });

const member = (name: string, extra: Partial<TeamMember> = {}): TeamMember => ({
  project: "demo", email: `${name.replace(/^worker-/, "")}@agents.test`, role: name.replace(/^worker-demo-/, ""), host: "100.66.1.6", port: 22,
  username: "dev", workdir: `/work/.worktrees/${name.replace(/^worker-/, "")}`, tmux: { id: "$1", created: 1, name }, ...extra,
});
const session = (name: string, extra: Record<string, unknown> = {}) => parseAgentSessions(payload([row(name, extra)])).sessions[0];

describe("parseAgentSessions (data mapping)", () => {
  it("maps collector fields and fills neutral defaults", () => {
    const snap = parseAgentSessions(payload([
      row("worker-demo-cw3-agy", { host: "cowork3", tool: "agy", task_code: "T0504", task_status: "doing", state: "running", dirty: 35, model: "Gemini", context_pct: 54, commit_subject: "fix: x" }),
      row("worker-demo-cw1-codex"),
      { host: "cowork1", state: "idle" },
      null,
    ]));
    expect(snap).toMatchObject({ now: NOW, ttlSeconds: 180, alertAfterSeconds: 600, collectedAt: NOW - 24 });
    expect(snap.sessions).toHaveLength(2);
    expect(snap.sessions[0]).toMatchObject({
      host: "cowork3", session: "worker-demo-cw3-agy", box: "demo-cw3-agy", tool: "agy", state: "running", stateSince: NOW - 3600,
      hostOk: true, stale: false, taskCode: "T0504", taskStatus: "doing", commitHash: "a279fa74", commitTime: NOW - 7200,
      commitSubject: "fix: x", dirty: 35, model: "Gemini", contextPct: 54, worktree: "/work/.worktrees/demo-cw3-agy",
    });
    // task_status / model / context_pct are absent when the session has no card or the tool reports no model.
    expect(snap.sessions[1]).toMatchObject({ taskCode: "", taskStatus: "", model: "" });
    expect(snap.sessions[1].contextPct).toBeUndefined();
  });

  it("rejects a body without a sessions array", () => {
    expect(() => parseAgentSessions({})).toThrow("格式无效");
    expect(() => parseAgentSessions([])).toThrow("格式无效");
    expect(parseAgentSessions({ sessions: [] }).ttlSeconds).toBe(180);
  });
});

describe("liveStatus", () => {
  it.each([
    [{ state: "stuck", state_detail: "429" }, "卡住：429", "bad", true],
    [{ state: "input_pending" }, "输入框残留", "warn", true],
    [{ state: "waiting_input", state_detail: "确认框/菜单" }, "等确认：确认框/菜单", "wait", true],
    [{ state: "gone", task_code: "T1", task_status: "doing" }, "会话已离开，卡仍在进行中", "bad", true],
    [{ state: "gone", task_code: "T1", task_status: "done" }, "会话已离开", "gone", false],
    [{ state: "running" }, "运行中", "run", false],
    [{ state: "idle" }, "空闲·可派活", "idle", false],
    [{ state: "stuck", stale: true }, "采集中断", "offline", false],
    [{ state: "running", host_ok: false, host_error: "timeout" }, "机器不可达", "offline", false],
  ])("%o → %s", (extra, label, tone, needsHuman) => {
    const status = liveStatus(session("worker-x", extra), NOW);
    expect(status).toMatchObject({ label, tone, needsHuman, duration: "1 小时" });
  });
  it("reports a member the collector never saw", () => {
    expect(liveStatus(undefined, NOW)).toMatchObject({ tone: "none", needsHuman: false, label: "看板未采集到会话" });
  });
});

describe("rankMembers (state ordering)", () => {
  it("puts people-needed states first, longest waiting first, and keeps roster order otherwise", () => {
    const names = ["idle-a", "running", "gone-done", "absent", "waiting", "stuck-new", "pending", "gone-doing", "idle-b", "stuck-old", "stale"].map(n => `worker-demo-${n}`);
    const snap = parseAgentSessions(payload([
      row("worker-demo-idle-a"), row("worker-demo-idle-b"),
      row("worker-demo-running", { state: "running" }),
      row("worker-demo-gone-done", { state: "gone", task_code: "T1", task_status: "done" }),
      row("worker-demo-gone-doing", { state: "gone", task_code: "T2", task_status: "doing" }),
      row("worker-demo-waiting", { state: "waiting_input" }),
      row("worker-demo-pending", { state: "input_pending" }),
      row("worker-demo-stuck-new", { state: "stuck", state_since: NOW - 60 }),
      row("worker-demo-stuck-old", { state: "stuck", state_since: NOW - 6000 }),
      row("worker-demo-stale", { state: "running", stale: true }),
    ]));
    const order = rankMembers(names.map(n => member(n)), snap).map(r => r.member.role);
    expect(order).toEqual(["stuck-old", "stuck-new", "pending", "waiting", "gone-doing", "running", "idle-a", "idle-b", "stale", "gone-done", "absent"]);
  });
  it("without a snapshot falls back to the Lead's hand-written state: working, idle, unknown, roster order within", () => {
    const ranked = rankMembers([
      member("worker-demo-b"), member("worker-demo-a", { currentTask: "空闲·等待派工" }),
      member("worker-demo-c", { currentTask: "工作中·T1 等合入" }), member("worker-demo-d", { currentTask: "T2 进行中" }),
    ], undefined);
    expect(ranked.map(r => [r.member.role, r.status.label, r.status.group])).toEqual([
      ["c", "工作中（手写）", "rosterWorking"], ["d", "工作中（手写）", "rosterWorking"], ["a", "空闲（手写）", "rosterIdle"], ["b", "待确认（手写）", "rosterUnknown"],
    ]);
    expect(ranked.every(r => !r.status.needsHuman && !r.session)).toBe(true);
  });
});

describe("idle split (空闲·可派活 / 等 Lead / 已交付·待验收)", () => {
  it.each([
    [{}, "空闲·可派活", "available", "idle"],
    [{ task_code: "T1", task_status: "done" }, "空闲·可派活", "available", "idle"],
    [{ task_code: "T1", task_status: "deferred" }, "空闲·可派活", "available", "idle"],
    [{ task_code: "T1", task_status: "doing" }, "等 Lead", "waitLead", "lead"],
    [{ task_code: "T1", task_status: "blocked" }, "等 Lead", "waitLead", "lead"],
    [{ task_code: "T1", task_status: "review" }, "已交付·待验收", "review", "review"],
    // A status without a card code is not a card.
    [{ task_code: "", task_status: "doing" }, "空闲·可派活", "available", "idle"],
  ])("idle + %o → %s", (extra, label, group, tone) => {
    const status = liveStatus(session("worker-x", { state: "idle", ...extra }), NOW);
    expect(status).toMatchObject({ label, group, tone, needsHuman: false, duration: "1 小时" });
  });
  it("only splits idle: a running worker with a doing card is still 运行中", () => {
    expect(liveStatus(session("worker-x", { state: "running", task_code: "T1", task_status: "doing" }), NOW)).toMatchObject({ label: "运行中", group: "running" });
  });
  it("never shows the Lead as waiting for itself or as available", () => {
    const lead = liveStatus(session("lead", { state: "idle", task_code: "T1", task_status: "doing" }), NOW, 180, true);
    expect(lead).toMatchObject({ label: "空闲", group: "lead" });
    expect(liveStatus(session("lead", { state: "stuck" }), NOW, 180, true)).toMatchObject({ group: "lead", needsHuman: true });
  });
  it("sorts 等 Lead after 需要处理 and before 待验收 / 运行中 / 可派活, longest wait first", () => {
    const names = ["free", "run", "lead-short", "review", "stuck", "lead-long"].map(n => `worker-demo-${n}`);
    const snap = parseAgentSessions(payload([
      row("worker-demo-free"),
      row("worker-demo-run", { state: "running" }),
      row("worker-demo-lead-short", { task_code: "T1", task_status: "doing", state_since: NOW - 3 * 3600 }),
      row("worker-demo-review", { task_code: "T2", task_status: "review" }),
      row("worker-demo-stuck", { state: "stuck" }),
      row("worker-demo-lead-long", { task_code: "T3", task_status: "blocked", state_since: NOW - 10 * 3600 }),
    ]));
    const ranked = rankMembers(names.map(n => member(n)), snap);
    expect(ranked.map(r => r.member.role)).toEqual(["stuck", "lead-long", "lead-short", "review", "run", "free"]);
    expect(summarizeTeam(ranked, snap)).toEqual({ live: true, attention: 1, waitLead: 2, longestWaitLead: "10 小时", review: 1, available: 1 });
  });
  it("summary without live data says so and counts nothing as waiting", () => {
    const ranked = rankMembers([member("worker-demo-a", { currentTask: "工作中·T1" })], undefined);
    expect(summarizeTeam(ranked, undefined)).toEqual({ live: false, attention: 0, waitLead: 0, longestWaitLead: "", review: 0, available: 0 });
  });
});

describe("Lead 备注 freshness and offline fallback", () => {
  const at = (hoursAgo: number) => new Date(NOW * 1000 - hoursAgo * 3600_000).toISOString();
  it.each([
    [at(2), "2 小时前", false],
    [at(23.9), "23 小时前", false],
    [at(25), "25 小时前", true],
    [at(24 * 5), "5 天前", true],
    [undefined, "更新时间未知", true],
    ["not a date", "更新时间未知", true],
  ])("updatedAt %s → %s (stale=%s)", (updatedAt, age, stale) => {
    expect(noteFreshness(updatedAt, NOW * 1000)).toEqual({ age, stale });
  });
  it("uses live data only while the board answers", () => {
    const snapshot = parseAgentSessions(payload([]));
    expect(liveSnapshot({ snapshot, offline: false })).toBe(snapshot);
    expect(liveSnapshot({ snapshot, offline: true })).toBeUndefined();
    expect(liveSnapshot({ offline: false })).toBeUndefined();
    expect(liveSnapshot(undefined)).toBeUndefined();
  });
  it("roster fallback follows the hand-written 「当前在做」 and marks it as hand-written", () => {
    expect(rosterStatus({ currentTask: "工作中·T0502等合入\n门禁已过" })).toMatchObject({ label: "工作中（手写）", group: "rosterWorking", needsHuman: false });
    expect(rosterStatus({ currentTask: "空闲·等待派工" })).toMatchObject({ label: "空闲（手写）", group: "rosterIdle" });
    expect(rosterStatus({})).toMatchObject({ label: "待确认（手写）", group: "rosterUnknown" });
    expect(rosterStatus({ currentTask: "工作中" }, true)).toMatchObject({ group: "lead" });
  });
  it("recognises the Lead by role or by being the panel's own session", () => {
    const self = { tmuxId: "$9", tmuxCreated: 9, workdir: "/lead", username: "dev" };
    expect(isLeadMember(member("x", { role: "Lead" }), self)).toBe(true);
    expect(isLeadMember(member("x", { role: "lead（主控）" }), self)).toBe(true);
    expect(isLeadMember(member("x", { role: "协调", tmux: { id: "$9", created: 9, name: "x" }, workdir: "/lead" }), self)).toBe(true);
    expect(isLeadMember(member("x", { role: "Leader-ish worker" }), self)).toBe(false);
  });
});

describe("briefTargets", () => {
  it("asks only for cards of live (or gone-but-doing) matched sessions, in each session's own board project", () => {
    const snap = parseAgentSessions(payload([
      row("a", { project: "smart-table", task_code: "T1", state: "running" }),
      row("b", { project: "smart-table", task_code: "T2", state: "gone", task_status: "done" }),
      row("c", { project: "smart-table", task_code: "T3", state: "gone", task_status: "doing" }),
      row("d", { project: "smart-table", task_code: "T1", state: "idle" }),
      row("e", { project: "", task_code: "T4" }),
    ]));
    expect(briefTargets([...snap.sessions, undefined])).toEqual([{ project: "smart-table", code: "T1" }, { project: "smart-table", code: "T3" }]);
  });
});

describe("matchSession (member ↔ session)", () => {
  const two = (a: Record<string, unknown>, b: Record<string, unknown>) => parseAgentSessions(payload([row("worker-demo-x", a), row("worker-demo-x", b)])).sessions;

  it("matches by tmux session name even when the roster stores an IP and the collector an ssh alias", () => {
    const sessions = parseAgentSessions(payload([row("worker-demo-cw3-agy", { host: "cowork3" }), row("worker-demo-cw1-pi")])).sessions;
    expect(matchSession(member("worker-demo-cw3-agy", { host: "100.66.1.9" }), sessions)?.host).toBe("cowork3");
    expect(matchSession(member("worker-demo-nobody"), sessions)).toBeUndefined();
  });
  it("disambiguates a shared session name by host, tolerating user@, port, case and domain", () => {
    const sessions = two({ host: "cowork1", state: "idle" }, { host: "cowork3", state: "running" });
    expect(matchSession(member("worker-demo-x", { host: "deng@Cowork3.lan:22" }), sessions)?.state).toBe("running");
    expect(matchSession(member("worker-demo-x", { host: "COWORK1" }), sessions)?.state).toBe("idle");
  });
  it("falls back to the worktree, then the mailbox, when hosts are written differently", () => {
    const byWorktree = two({ host: "cowork1", worktree: "/a" }, { host: "cowork3", worktree: "/b", state: "running" });
    expect(matchSession(member("worker-demo-x", { host: "100.66.1.9", workdir: "/b" }), byWorktree)?.state).toBe("running");
    const byBox = two({ host: "cowork1", box: "demo-other" }, { host: "cowork3", box: "demo-x", state: "running" });
    expect(matchSession(member("worker-demo-x", { host: "100.66.1.9", workdir: "/none", email: "Demo-X@agents.test" }), byBox)?.state).toBe("running");
  });
  it("uses the mailbox when the session was renamed, and prefers a live session over a gone one", () => {
    const renamed = parseAgentSessions(payload([row("demo-x-new", { box: "demo-x", state: "running" })])).sessions;
    expect(matchSession(member("worker-demo-x"), renamed)?.session).toBe("demo-x-new");
    const sessions = two({ state: "gone", seen_at: NOW }, { state: "idle", seen_at: NOW - 30 });
    expect(matchSession(member("worker-demo-x", { host: "cowork1" }), sessions)?.state).toBe("idle");
  });
  it("normalizes host spellings", () => {
    expect(normalizeHost(" deng@Cowork1.local:2222 ")).toBe("cowork1");
    expect(normalizeHost("100.66.1.6:22")).toBe("100.66.1.6");
    expect(normalizeHost("[fe80::1]:22")).toBe("fe80::1");
  });
});

// ---------- component: live data, offline fallback, refresh timer ----------
const server: ServerEntry = { id: "lead", name: "Lead", host: "100.66.1.6", port: 22, username: "dev", authMethod: "password" };
const profile = { ...emptyProfile(), enabled: true, project: "demo", workdir: "/lead", tmuxId: "$9", tmuxCreated: 9, tmuxName: "lead" };
const navigation = { server, servers: [server], onOpen: vi.fn() };
const board = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test:8091" })!;
const roster = [member("worker-demo-cw1-codex"), member("worker-demo-cw3-agy", { host: "100.66.1.9" }), member("worker-demo-cw1-pi")];
const state: { sessions: unknown; offline: boolean; paths: string[] } = { sessions: undefined, offline: false, paths: [] };

function fakeBoard(command: string, args: { path: string }) {
  if (command !== "taskboard_get") return Promise.reject(new Error(`unexpected ${command}`));
  state.paths.push(args.path);
  if (state.offline) return Promise.reject(new Error("看板不可达：无法连接看板服务"));
  const json = (body: unknown) => Promise.resolve({ status: 200, body: JSON.stringify(body) });
  if (args.path === "/api/v1/agent-sessions") return json(state.sessions);
  if (args.path === "/api/v1/projects/demo/statuses") return json({ statuses: [{ key: "doing", name: "进行中" }, { key: "review", name: "待验收" }] });
  if (args.path === "/api/v1/projects/demo/tasks/T0504") return json({ code: "T0504", title: "长标题", brief: "告警带设备标识时主动去查" });
  if (args.path === "/api/v1/projects/demo/tasks/T0503") return json({ code: "T0503", title: "只有标题的卡", brief: "" });
  return Promise.resolve({ status: 404, body: "{}" });
}

beforeEach(() => {
  clearBoardCache();
  state.offline = false; state.paths = [];
  state.sessions = payload([
    row("worker-demo-cw1-codex"),
    row("worker-demo-cw3-agy", { host: "cowork3", state: "running", task_code: "T0504", task_status: "doing", dirty: 35, model: "Gemini 4", commit_subject: "chore(s4): apply review" }),
    row("worker-demo-cw1-pi", { state: "waiting_input", state_detail: "确认框/菜单", task_code: "T0503", task_status: "review", state_since: NOW - 900 }),
    // Another project's session in the global list: never shown, its card never fetched.
    row("worker-other-cw1-codex", { project: "other", state: "stuck", task_code: "X1", task_status: "doing" }),
  ]);
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(fakeBoard);
});
afterEach(() => { vi.useRealTimers(); });

const rows = () => screen.getAllByRole("group").filter(e => e.classList.contains("team-live-row"));

it("renders live status, card brief, last commit, dirty files and model without calling AI", async () => {
  render(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={roster} board={board} onUpdated={vi.fn()}/>);
  await screen.findByText("告警带设备标识时主动去查");
  const [first, second, third] = rows();
  // waiting_input needs a person: first, highlighted, in the 「需要处理」 group.
  expect(first.classList.contains("team-live-alert")).toBe(true);
  expect(within(first).getByText("等确认：确认框/菜单")).toBeTruthy();
  expect(within(first).getByText("15 分钟")).toBeTruthy();
  expect(within(first).getByText("待验收")).toBeTruthy();
  expect(within(first).getByText("只有标题的卡")).toBeTruthy();
  expect(within(document.querySelector(".team-live-group-attention") as HTMLElement).getAllByRole("group")).toHaveLength(1);
  expect(within(second).getByText("运行中")).toBeTruthy();
  expect(within(second).getByText("T0504")).toBeTruthy();
  expect(within(second).getByText("进行中")).toBeTruthy();
  expect(within(second).getByText("未提交 35 个文件")).toBeTruthy();
  expect(within(second).getByText("Gemini 4")).toBeTruthy();
  expect(within(second).getByText("提交 2 小时前 · chore(s4): apply review")).toBeTruthy();
  expect(within(third).getByText("空闲·可派活")).toBeTruthy();
  expect(within(third).getByText("无当前卡")).toBeTruthy();
  // AI summary stays on demand.
  expect(screen.getByRole("button", { name: "总结 · cw1-pi" })).toBeTruthy();
  expect(mocks.invoke.mock.calls.every(([command]) => command === "taskboard_get")).toBe(true);
  expect(rows()).toHaveLength(3);
  expect(state.paths.some(p => p.includes("/other/"))).toBe(false);
});

it("shows 「看板离线」 instead of an error when the board is unreachable, and recovers on the next minute", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  state.offline = true;
  render(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={roster} board={board} onUpdated={vi.fn()}/>);
  expect(await screen.findByText(/看板离线/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  // Falls back to the hand-written state instead of a blank 「unknown」.
  expect(screen.getAllByText("待确认（手写）")).toHaveLength(3);
  // Roster still shows, unranked, so 「打开」 and 「总结」 keep working.
  expect(rows().map(r => r.querySelector(".team-ai-identity")?.firstChild?.textContent)).toEqual(["cw1-codex", "cw3-agy", "cw1-pi"]);
  state.offline = false;
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  await waitFor(() => expect(screen.queryByText(/看板离线/)).toBeNull());
  expect(within(rows()[0]).getByText(/等确认/)).toBeTruthy();
});

it("refreshes every 60 seconds and stops when unmounted", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const clear = vi.spyOn(window, "clearInterval");
  const view = render(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={roster} board={board} onUpdated={vi.fn()}/>);
  await screen.findByText("T0504");
  const polls = () => state.paths.filter(p => p.endsWith("/agent-sessions")).length;
  expect(polls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(59_000); });
  expect(polls()).toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  expect(polls()).toBe(2);
  view.unmount();
  expect(clear).toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
  expect(polls()).toBe(2);
});

it("says the board is not configured when no source is available", () => {
  render(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={roster} onUpdated={vi.fn()}/>);
  expect(screen.getByText(/未配置看板，无法显示实时状态/)).toBeTruthy();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

// ---------- both pages read the same status ----------
const WEEK_OLD = new Date((NOW - 2 * 86400) * 1000).toISOString();
const team = [
  member("worker-demo-run"),
  member("worker-demo-wait", { currentTask: "工作中·T7 等合入", updatedAt: WEEK_OLD }),
  member("worker-demo-review"),
  member("worker-demo-free", { currentTask: "工作中·T5", updatedAt: new Date((NOW - 3600) * 1000).toISOString() }),
  member("worker-demo-stuck"),
  member("demo-lead", { role: "Lead", currentTask: "工作中·协调" }),
];
const teamSessions = () => payload([
  row("worker-demo-run", { state: "running", task_code: "T0504", task_status: "doing" }),
  row("worker-demo-wait", { task_code: "T7", task_status: "doing", state_since: NOW - 5 * 3600 }),
  row("worker-demo-review", { task_code: "T0503", task_status: "review", state_since: NOW - 2 * 3600 }),
  row("worker-demo-free", { task_code: "T5", task_status: "done" }),
  row("worker-demo-stuck", { state: "stuck", state_detail: "429" }),
  row("demo-lead"),
]);
function fakeTeam(command: string, args: { path?: string; request?: { operation: string } }) {
  if (command === "collaboration_request") return Promise.resolve(JSON.stringify(team));
  return fakeBoard(command, args as { path: string });
}
const statusByMember = (scope: ParentNode, rowSelector: string, nameOf: (row: Element) => string) =>
  Object.fromEntries([...scope.querySelectorAll(rowSelector)].map(r => [nameOf(r), [r.getAttribute("data-group"), r.querySelector(".team-live-badge")?.textContent]]));
const views = () => ({
  dynamics: statusByMember(document, ".team-dynamics .team-live-row", r => r.querySelector(".team-ai-identity")!.firstChild!.textContent!),
  roster: statusByMember(document, ".team-roster-view article.team-card", r => r.querySelector(".team-card-title strong")!.textContent!),
});
const rosterNavigation = { server, servers: [server], onOpen: vi.fn() };
const rosterProfile = { ...profile, membersEnabled: true };

it("「动态」 and 「成员」 show the same live status, groups and summary; 「当前」 is live and the hand-written note is 「Lead 备注」 with its age", async () => {
  state.sessions = teamSessions();
  mocks.invoke.mockImplementation(fakeTeam);
  render(<TeamMembers sessionId="ssh" profile={rosterProfile} navigation={rosterNavigation} board={board}/>);
  await waitFor(() => expect(document.querySelectorAll(".team-roster-view .team-live-badge")).toHaveLength(6));
  await screen.findAllByText("告警带设备标识时主动去查");
  const { dynamics, roster } = views();
  const expected = {
    stuck: ["attention", "卡住：429"], wait: ["waitLead", "等 Lead"], review: ["review", "已交付·待验收"],
    run: ["running", "运行中"], free: ["available", "空闲·可派活"],
  };
  expect(dynamics).toEqual(expected);
  // The roster also lists the Lead (never 「等 Lead」/「可派活」); everyone else reads exactly as on 「动态」.
  expect(roster).toEqual({ ...expected, Lead: ["lead", "空闲"] });
  // Same order on both pages.
  const order = (sel: string, name: string) => [...document.querySelectorAll(sel)].map(r => r.querySelector(name)!.textContent);
  expect(order(".team-dynamics .team-live-row", ".team-ai-identity")).toEqual(["stuckworker-demo-stuck", "waitworker-demo-wait", "reviewworker-demo-review", "runworker-demo-run", "freeworker-demo-free"]);
  expect(order(".team-roster-view article.team-card", ".team-card-title strong")).toEqual(["Lead", "stuck", "wait", "review", "run", "free"]);
  // One summary text on both pages; the Lead is not counted.
  const summaries = [...document.querySelectorAll(".team-live-summary")].map(e => e.textContent);
  expect(summaries).toEqual(["需要处理 1等 Lead 1（最长 5 小时）待验收 1可派活 1", "需要处理 1等 Lead 1（最长 5 小时）待验收 1可派活 1"]);
  // 等 Lead is highlighted yellow on both pages.
  expect(document.querySelectorAll(".team-live-wait-lead")).toHaveLength(2);
  // 「当前」 on the roster comes from the collector, not the stale hand-written note.
  const card = (name: string) => [...document.querySelectorAll(".team-roster-view article.team-card")].find(r => r.querySelector(".team-card-title strong")!.textContent === name) as HTMLElement;
  expect(within(card("run")).getByText("T0504")).toBeTruthy();
  expect(within(card("run")).getByText("告警带设备标识时主动去查")).toBeTruthy();
  expect(within(card("wait")).getByText("T7")).toBeTruthy();
  expect(within(card("wait")).getByText("Lead 备注")).toBeTruthy();
  expect(within(card("wait")).getByText(/2 天前 · 可能过期/)).toBeTruthy();
  expect(within(card("free")).getByText("1 小时前").classList.contains("is-stale")).toBe(false);
  expect(within(card("free")).queryByText(/可能过期/)).toBeNull();
  expect(document.querySelector(".team-roster-view")?.textContent).not.toMatch(/工作中（/);
  // One collector poll serves both pages.
  expect(state.paths.filter(p => p.endsWith("/agent-sessions"))).toHaveLength(1);
});

it("both pages fall back to the hand-written state and say 「看板离线」 when the board is unreachable", async () => {
  state.offline = true;
  mocks.invoke.mockImplementation(fakeTeam);
  render(<TeamMembers sessionId="ssh" profile={rosterProfile} navigation={rosterNavigation} board={board}/>);
  await waitFor(() => expect(document.querySelectorAll(".team-live-offline")).toHaveLength(2));
  expect(screen.queryByRole("alert")).toBeNull();
  const { dynamics, roster } = views();
  const expected = {
    run: ["rosterUnknown", "待确认（手写）"], wait: ["rosterWorking", "工作中（手写）"], review: ["rosterUnknown", "待确认（手写）"],
    free: ["rosterWorking", "工作中（手写）"], stuck: ["rosterUnknown", "待确认（手写）"],
  };
  expect(dynamics).toEqual(expected);
  expect(roster).toEqual({ ...expected, Lead: ["lead", "工作中（手写）"] });
  expect(document.querySelectorAll(".team-live-summary")).toHaveLength(0);
  // Dynamics shows the hand-written note in place of the live card.
  expect(document.querySelector(".team-dynamics .team-live-task.is-roster")?.textContent).toBe("Lead 备注工作中·T7 等合入");
});
