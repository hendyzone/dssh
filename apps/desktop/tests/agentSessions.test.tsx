import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../src/lib/teamService",()=>({useTeamService:()=>({url:"https://team.example.invalid",projects:["demo"],status:{state:"online",token_configured:true},snapshots:{demo:{project:"demo",identity:"service-demo",seq:1,members:team,ai:{},machines:{},live:Object.fromEntries(team.map(member=>[member.email||member.id,{match:"no_agent"}])),receivedAt:Date.now(),offline:false,status:"online"}}})}));
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
  host: "host-a", session, box: session.replace(/^worker-/, ""), tool: "codex", project: "demo",
  task_code: "", bind_via: "", state: "idle", state_detail: "", state_since: NOW - 3600, host_ok: true, stale: false,
  first_seen: NOW - 86400, seen_at: NOW - 24, worktree: `/work/.worktrees/${session.replace(/^worker-/, "")}`, branch: "main",
  commit_hash: "a279fa74", commit_time: NOW - 7200, commit_subject: "chore: something", dirty: 0, last_line: "", activity_at: NOW - 3600,
  ...extra,
});
const payload = (sessions: unknown[]) => ({ sessions, now: NOW, ttl_seconds: 180, alert_after_seconds: 600, last_collected_at: NOW - 24 });

const member = (name: string, extra: Partial<TeamMember> = {}): TeamMember => ({
  project: "demo", email: `${name.replace(/^worker-/, "")}@agents.test`, role: name.replace(/^worker-demo-/, ""), host: "192.0.2.6", port: 22,
  username: "dev", workdir: `/work/.worktrees/${name.replace(/^worker-/, "")}`, tmux: { id: "$1", created: 1, name }, ...extra,
});
const session = (name: string, extra: Record<string, unknown> = {}) => parseAgentSessions(payload([row(name, extra)])).sessions[0];

describe("parseAgentSessions (data mapping)", () => {
  it("maps collector fields and fills neutral defaults", () => {
    const snap = parseAgentSessions(payload([
      row("worker-demo-host-c-agy", { host: "host-b", tool: "agy", task_code: "T0504", task_status: "doing", state: "running", dirty: 35, model: "Gemini", context_pct: 54, commit_subject: "fix: x" }),
      row("worker-demo-host-a-codex"),
      { host: "host-a", state: "idle" },
      null,
    ]));
    expect(snap).toMatchObject({ now: NOW, ttlSeconds: 180, alertAfterSeconds: 600, collectedAt: NOW - 24 });
    expect(snap.sessions).toHaveLength(2);
    expect(snap.sessions[0]).toMatchObject({
      host: "host-b", session: "worker-demo-host-c-agy", box: "demo-host-c-agy", tool: "agy", state: "running", stateSince: NOW - 3600,
      hostOk: true, stale: false, taskCode: "T0504", taskStatus: "doing", commitHash: "a279fa74", commitTime: NOW - 7200,
      commitSubject: "fix: x", dirty: 35, model: "Gemini", contextPct: 54, worktree: "/work/.worktrees/demo-host-c-agy",
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
    const sessions = parseAgentSessions(payload([row("worker-demo-host-c-agy", { host: "host-b" }), row("worker-demo-host-a-pi")])).sessions;
    expect(matchSession(member("worker-demo-host-c-agy", { host: "192.0.2.9" }), sessions)?.host).toBe("host-b");
    expect(matchSession(member("worker-demo-nobody"), sessions)).toBeUndefined();
  });
  it("disambiguates a shared session name by host, tolerating user@, port, case and domain", () => {
    const sessions = two({ host: "host-a", state: "idle" }, { host: "host-b", state: "running" });
    expect(matchSession(member("worker-demo-x", { host: "dev@host-b.test:22" }), sessions)?.state).toBe("running");
    expect(matchSession(member("worker-demo-x", { host: "HOST-A" }), sessions)?.state).toBe("idle");
  });
  it("falls back to the worktree, then the mailbox, when hosts are written differently", () => {
    const byWorktree = two({ host: "host-a", worktree: "/a" }, { host: "host-b", worktree: "/b", state: "running" });
    expect(matchSession(member("worker-demo-x", { host: "192.0.2.9", workdir: "/b" }), byWorktree)?.state).toBe("running");
    const byBox = two({ host: "host-a", box: "demo-other" }, { host: "host-b", box: "demo-x", state: "running" });
    expect(matchSession(member("worker-demo-x", { host: "192.0.2.9", workdir: "/none", email: "Demo-X@agents.test" }), byBox)?.state).toBe("running");
  });
  it("uses the mailbox when the session was renamed, and prefers a live session over a gone one", () => {
    const renamed = parseAgentSessions(payload([row("demo-x-new", { box: "demo-x", state: "running" })])).sessions;
    expect(matchSession(member("worker-demo-x"), renamed)?.session).toBe("demo-x-new");
    const sessions = two({ state: "gone", seen_at: NOW }, { state: "idle", seen_at: NOW - 30 });
    expect(matchSession(member("worker-demo-x", { host: "host-a" }), sessions)?.state).toBe("idle");
  });
  it("normalizes host spellings", () => {
    expect(normalizeHost(" dev@host-a.test:2222 ")).toBe("host-a");
    expect(normalizeHost("192.0.2.6:22")).toBe("192.0.2.6");
    expect(normalizeHost("[fe80::1]:22")).toBe("fe80::1");
  });
});

// ---------- component: live data, offline fallback, refresh timer ----------
const server: ServerEntry = { id: "lead", name: "Lead", host: "192.0.2.6", port: 22, username: "dev", authMethod: "password" };
const profile = { ...emptyProfile(), enabled: true, project: "demo", workdir: "/lead", tmuxId: "$9", tmuxCreated: 9, tmuxName: "lead" };
const navigation = { server, servers: [server], onOpen: vi.fn() };
const board = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test:8091" })!;
const roster = [member("worker-demo-host-a-codex"), member("worker-demo-host-c-agy", { host: "192.0.2.9" }), member("worker-demo-host-a-pi")];
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
    row("worker-demo-host-a-codex"),
    row("worker-demo-host-c-agy", { host: "host-b", state: "running", task_code: "T0504", task_status: "doing", dirty: 35, model: "Gemini 4", commit_subject: "chore(s4): apply review" }),
    row("worker-demo-host-a-pi", { state: "waiting_input", state_detail: "确认框/菜单", task_code: "T0503", task_status: "review", state_since: NOW - 900 }),
    // Another project's session in the global list: never shown, its card never fetched.
    row("worker-other-host-a-codex", { project: "other", state: "stuck", task_code: "X1", task_status: "doing" }),
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
  expect([...document.querySelectorAll(".team-live-group-attention .team-live-row")]).toHaveLength(1);
  expect(within(second).getByText("运行中")).toBeTruthy();
  expect(within(second).getByText("T0504")).toBeTruthy();
  expect(within(second).getByText("进行中")).toBeTruthy();
  expect(within(second).getByText("未提交 35 个文件")).toBeTruthy();
  expect(within(second).getByText("Gemini 4")).toBeTruthy();
  expect(within(second).getByText("提交 2 小时前 · chore(s4): apply review")).toBeTruthy();
  expect(within(third).getByText("空闲·可派活")).toBeTruthy();
  // 空闲成员是可派活的紧凑行；没有当前卡时不再显示「无当前卡」空信息
  expect(third.classList.contains("team-compact-row")).toBe(true);
  expect(screen.queryByText("无当前卡")).toBeNull();
  // AI summary stays on demand.
  expect(screen.queryByRole("button", { name: "总结 · demo-host-a-pi" })).toBeNull();
  expect(screen.getByText("AI 摘要由团队服务生成")).toBeTruthy();
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
  // Roster still shows, unranked, and terminal navigation stays available.
  expect(rows().map(r => r.querySelector(".team-ai-identity")?.firstChild?.textContent)).toEqual(["demo-host-a-codex", "demo-host-c-agy", "demo-host-a-pi"]);
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

const rosterNavigation = { server, servers: [server], onOpen: vi.fn() };
const rosterProfile = { ...profile, membersEnabled: true };

it("the merged list shows live status, groups and the clickable summary; Lead is a compact row with no counts", async () => {
  state.sessions = teamSessions();
  mocks.invoke.mockImplementation(fakeTeam);
  render(<TeamMembers sessionId="ssh" profile={rosterProfile} navigation={rosterNavigation} board={board}/>);
  await waitFor(() => expect(document.querySelectorAll(".team-live-row")).toHaveLength(6));
  await screen.findAllByText("告警带设备标识时主动去查");
  const dynamics = statusByMember(document, ".team-dynamics .team-live-row", r => r.querySelector(".team-ai-identity")!.firstChild!.textContent!);
  const expected = {
    "demo-lead": ["lead", "空闲"], "demo-stuck": ["attention", "卡住：429"], "demo-wait": ["waitLead", "等 Lead"],
    "demo-review": ["review", "已交付·待验收"], "demo-run": ["running", "运行中"], "demo-free": ["available", "空闲·可派活"],
  };
  expect(dynamics).toEqual(expected);
  // 紧急度排序不变，Lead 组挪到最后（紧凑行）
  expect([...document.querySelectorAll(".team-live-group")].map(g => g.getAttribute("aria-label")))
    .toEqual(["需要处理成员", "等 Lead成员", "已交付·待验收成员", "运行中成员", "空闲·可派活成员", "Lead成员"]);
  // 概览是三个可点的计数块（Lead 不计入）
  const chips = [...document.querySelectorAll(".team-live-counts button")].map(b => [b.querySelector("span")?.textContent, b.querySelector("b")?.textContent]);
  expect(chips).toEqual([["需要处理", "1"], ["等 Lead", "1"], ["可派活", "1"]]);
  // 待验收仍有分组，计数在组标题
  expect(document.querySelector(".team-live-group-review .team-activity-heading")?.textContent).toContain("已交付·待验收");
  // 等 Lead 仍带黄色左边框标记
  expect(document.querySelectorAll(".team-live-wait-lead").length).toBeGreaterThan(0);
  // Lead 是紧凑行（管理入口在它的展开详情里），但不计入三个计数
  expect(document.querySelector(".team-live-group-lead .team-compact-row")).toBeTruthy();
  expect(document.querySelector(".team-live-group-lead")?.textContent).toContain("Lead");
  const rowOf = (name: string) => [...document.querySelectorAll(".team-dynamics .team-live-row")]
    .find(r => r.querySelector(".team-ai-identity")?.firstChild?.textContent === name) as HTMLElement;
  const openRow = (row: HTMLElement) => { row.open = true; fireEvent(row, new Event("toggle")); };
  expect(within(rowOf("demo-run")).getByText("T0504")).toBeTruthy();
  expect(within(rowOf("demo-run")).getByText("告警带设备标识时主动去查")).toBeTruthy();
  expect(within(rowOf("demo-wait")).getByText("T7")).toBeTruthy();
  // 管理/备注区只在展开时渲染
  openRow(rowOf("demo-wait"));
  expect(within(rowOf("demo-wait")).getByText("Lead 备注")).toBeTruthy();
  expect(within(rowOf("demo-wait")).getByText(/2 天前 · 可能过期/)).toBeTruthy();
  openRow(rowOf("demo-free"));
  expect(within(rowOf("demo-free")).getByText("1 小时前").classList.contains("is-stale")).toBe(false);
  // 合并后只有一份采集
  expect(state.paths.filter(p => p.endsWith("/agent-sessions"))).toHaveLength(1);
});

it("the merged list falls back to the hand-written state and says 「看板离线」 when the board is unreachable", async () => {
  state.offline = true;
  mocks.invoke.mockImplementation(fakeTeam);
  render(<TeamMembers sessionId="ssh" profile={rosterProfile} navigation={rosterNavigation} board={board}/>);
  await waitFor(() => expect(document.querySelectorAll(".team-live-offline")).toHaveLength(1));
  expect(screen.queryByRole("alert")).toBeNull();
  const dynamics = statusByMember(document, ".team-dynamics .team-live-row", r => r.querySelector(".team-ai-identity")!.firstChild!.textContent!);
  expect(dynamics).toEqual({
    "demo-lead": ["lead", "工作中（手写）"], "demo-run": ["rosterUnknown", "待确认（手写）"], "demo-wait": ["rosterWorking", "工作中（手写）"],
    "demo-review": ["rosterUnknown", "待确认（手写）"], "demo-free": ["rosterWorking", "工作中（手写）"], "demo-stuck": ["rosterUnknown", "待确认（手写）"],
  });
  // 看板离线时不显示实时计数块
  expect(document.querySelectorAll(".team-live-counts")).toHaveLength(0);
  // 看板离线时用 Lead 备注顶替实时信息
  expect([...document.querySelectorAll(".team-dynamics .team-compact-card.is-roster")].map(e => e.textContent))
    .toEqual(["工作中·T7 等合入", "工作中·T5", "工作中·协调"]);
});
