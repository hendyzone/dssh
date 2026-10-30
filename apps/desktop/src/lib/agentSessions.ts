import { useEffect, useRef, useState } from "react";
import { BoardError, cached, formatAge, get, isIdentifier, listStatuses, type BoardSource } from "./taskLookup";
import { memberActivity, memberActivityLabels, type TeamMember } from "./teamMembers";

/**
 * Live member status from the taskboard collector (`GET /api/v1/projects/<p>/agent-sessions`).
 * The collector scans every machine's tmux once a minute, read-only; dssh only displays it.
 * Labels and ranking follow the web board so both read the same.
 */
export interface AgentSession {
  host: string; session: string; box: string; tool: string; project: string;
  state: string; stateDetail: string; stateSince: number;
  hostOk: boolean; hostError: string; stale: boolean; seenAt: number;
  taskCode: string; taskStatus: string;
  worktree: string; branch: string;
  commitHash: string; commitTime: number; commitSubject: string;
  dirty: number; model: string; contextPct?: number; lastLine: string;
}
export interface SessionsSnapshot { sessions: AgentSession[]; now: number; ttlSeconds: number; alertAfterSeconds: number; collectedAt: number }
export interface TaskBrief { code: string; title: string; brief: string }

const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Tolerant mapping: unknown fields are ignored, missing ones get neutral defaults, rows without a session name are dropped. */
export function parseAgentSessions(raw: unknown): SessionsSnapshot {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { sessions?: unknown }).sessions)) throw new BoardError("format", "看板会话数据格式无效");
  const data = raw as Record<string, unknown> & { sessions: unknown[] };
  const sessions = data.sessions
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && typeof (s as { session?: unknown }).session === "string" && !!(s as { session: string }).session)
    .map(s => ({
      host: str(s.host), session: str(s.session), box: str(s.box), tool: str(s.tool), project: str(s.project),
      state: str(s.state) || "unknown", stateDetail: str(s.state_detail), stateSince: num(s.state_since),
      hostOk: s.host_ok !== false, hostError: str(s.host_error), stale: s.stale === true, seenAt: num(s.seen_at),
      taskCode: str(s.task_code), taskStatus: str(s.task_status),
      worktree: str(s.worktree), branch: str(s.branch),
      commitHash: str(s.commit_hash), commitTime: num(s.commit_time), commitSubject: str(s.commit_subject),
      dirty: num(s.dirty), model: str(s.model), lastLine: str(s.last_line),
      ...(typeof s.context_pct === "number" ? { contextPct: s.context_pct } : {}),
    }));
  const now = num(data.now) || Math.floor(Date.now() / 1000);
  return { sessions, now, ttlSeconds: num(data.ttl_seconds) || 180, alertAfterSeconds: num(data.alert_after_seconds) || 600, collectedAt: num(data.last_collected_at) };
}

// ---------- member ↔ session ----------
/** 「dev@host-a.test:22」→「host-a」: drop user, port and domain so aliases written differently still compare. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase().replace(/^.*@/, "");
  if (/^\[.*\](:\d+)?$/.test(h)) return h.replace(/^\[|\](:\d+)?$/g, "");
  h = h.replace(/:\d+$/, "");
  return /^\d+(\.\d+){3}$/.test(h) ? h : h.split(".")[0];
}
const mailbox = (email: string) => email.trim().toLowerCase().replace(/@.*$/, "");
const sessionOrder = (a: AgentSession, b: AgentSession) =>
  Number(a.state === "gone") - Number(b.state === "gone") || Number(a.stale) - Number(b.stale) || b.seenAt - a.seenAt;

/**
 * Session of a roster member. The tmux session name (`tmux.name`) is the key. When several hosts
 * have a session of that name, narrow by host (aliases normalised), then worktree, then box
 * (= mailbox of the member's email); a narrowing that would leave nothing is skipped because the
 * roster often stores an IP where the collector reports an ssh alias. Without a name match, the
 * box is the fallback (session renamed). Live sessions win over gone/stale ones.
 */
export function matchSession(member: Pick<TeamMember, "host" | "workdir" | "email" | "tmux">, sessions: AgentSession[]): AgentSession | undefined {
  let candidates = sessions.filter(s => s.session === member.tmux.name);
  const box = mailbox(member.email);
  if (!candidates.length && box) candidates = sessions.filter(s => s.box.toLowerCase() === box);
  for (const narrow of [
    (s: AgentSession) => normalizeHost(s.host) === normalizeHost(member.host),
    (s: AgentSession) => !!s.worktree && s.worktree === member.workdir,
    (s: AgentSession) => !!box && s.box.toLowerCase() === box,
  ]) {
    if (candidates.length <= 1) break;
    const kept = candidates.filter(narrow);
    if (kept.length) candidates = kept;
  }
  return [...candidates].sort(sessionOrder)[0];
}

// ---------- display ----------
export type LiveTone = "bad" | "warn" | "wait" | "lead" | "review" | "run" | "idle" | "offline" | "gone" | "none";
/**
 * Display group, shared by the 「动态」 and 「成员」 pages. The `roster*` groups are the fallback
 * from the Lead's hand-written 「当前在做」 when there is no live data (board offline / not configured).
 */
export type StatusGroup = "lead" | "attention" | "waitLead" | "review" | "running" | "available" | "other" | "rosterWorking" | "rosterIdle" | "rosterUnknown";
export const STATUS_GROUPS: readonly { key: StatusGroup; label: string; title?: string }[] = [
  { key: "lead", label: "Lead" },
  { key: "attention", label: "需要处理", title: "卡住、确认框、输入框残留、会话已离开但卡仍在进行中" },
  { key: "waitLead", label: "等 Lead", title: "worker 已空闲，但卡仍在进行中 / 阻塞：活干完了在等 Lead 处理" },
  { key: "review", label: "已交付·待验收", title: "worker 已空闲，卡在待验收" },
  { key: "running", label: "运行中" },
  { key: "available", label: "空闲·可派活", title: "worker 空闲，名下没有进行中 / 阻塞 / 待验收的卡" },
  { key: "other", label: "离开 / 未采集" },
  { key: "rosterWorking", label: "工作中（Lead 手写）", title: "看板不可用，按 Lead 手写的「当前在做」分类，可能过期" },
  { key: "rosterIdle", label: "空闲（Lead 手写）", title: "看板不可用，按 Lead 手写的「当前在做」分类，可能过期" },
  { key: "rosterUnknown", label: "待确认（Lead 手写）", title: "看板不可用，按 Lead 手写的「当前在做」分类，可能过期" },
];
export interface LiveStatus {
  /** Lower comes first. */
  rank: number;
  tone: LiveTone;
  group: StatusGroup;
  label: string;
  title?: string;
  /** Someone has to act: stuck, a confirm prompt, unsent input, or a gone session whose card is still in progress. */
  needsHuman: boolean;
  /** 「12 分钟」 since the state began; empty when unknown. */
  duration: string;
}
const ALERT = new Set(["stuck", "input_pending", "waiting_input"]);
/** Card states that mean the worker handed back and the Lead has to move: still in progress / blocked. */
export const WAIT_LEAD_STATUSES: ReadonlySet<string> = new Set(["doing", "blocked"]);
const RANK: Record<string, number> = { lead: -1, stuck: 0, input_pending: 1, waiting_input: 2, gone_doing: 3, wait_lead: 4, review: 5, running: 6, idle: 7, offline: 8, gone: 9, unknown: 8, none: 10 };
const iso = (seconds: number) => (seconds > 0 ? new Date(seconds * 1000).toISOString() : "");
export const ago = (seconds: number, now: number) => formatAge(iso(seconds), now * 1000);

/**
 * Live status of one session. An idle worker is split by its card: no card (or one that is done /
 * deferred) → 「空闲·可派活」; card doing / blocked → 「等 Lead」; card in review → 「已交付·待验收」.
 * `lead` marks the Lead's own session, which is never 「waiting for the Lead」 nor 「available」.
 */
export function liveStatus(session: AgentSession | undefined, now: number, ttlSeconds = 180, lead = false): LiveStatus {
  if (!session) return { rank: RANK.none, tone: "none", group: lead ? "lead" : "other", label: "看板未采集到会话", needsHuman: false, duration: "", title: "看板没有这个 tmux 会话的记录：会话名与名单不一致，或这台机器不在采集范围内" };
  const duration = session.stateSince ? ago(session.stateSince, now) : "";
  const status = (s: Omit<LiveStatus, "duration">): LiveStatus => ({ ...s, duration, ...(lead ? { group: "lead" as const, rank: RANK.lead } : {}) });
  if (session.state !== "gone" && !session.hostOk)
    return status({ rank: RANK.offline, tone: "offline", group: "other", label: "机器不可达", needsHuman: false, title: `这台机器本轮探测失败${session.hostError ? "：" + session.hostError : ""}；下面是上次采集到的状态` });
  if (session.stale)
    return status({ rank: RANK.offline, tone: "offline", group: "other", label: "采集中断", needsHuman: false, title: `超过 ${ttlSeconds} 秒没采集到（采集进程停了？）；下面是最后一次的状态` });
  switch (session.state) {
    case "stuck": return status({ rank: RANK.stuck, tone: "bad", group: "attention", label: "卡住" + (session.stateDetail ? "：" + session.stateDetail : ""), needsHuman: true });
    case "input_pending": return status({ rank: RANK.input_pending, tone: "warn", group: "attention", label: "输入框残留", needsHuman: true, title: "输入框里有一条没提交的文字" });
    case "waiting_input": return status({ rank: RANK.waiting_input, tone: "wait", group: "attention", label: "等确认" + (session.stateDetail ? "：" + session.stateDetail : ""), needsHuman: true, title: "停在确认框 / 菜单" });
    case "running": return status({ rank: RANK.running, tone: "run", group: "running", label: "运行中", needsHuman: false });
    case "idle":
      if (lead) return status({ rank: RANK.idle, tone: "idle", group: "lead", label: "空闲", needsHuman: false });
      if (session.taskCode && WAIT_LEAD_STATUSES.has(session.taskStatus))
        return status({ rank: RANK.wait_lead, tone: "lead", group: "waitLead", label: "等 Lead", needsHuman: false, title: `已空闲，但卡 ${session.taskCode} 仍是「${session.taskStatus}」：活干完了在等 Lead 处理` });
      if (session.taskCode && session.taskStatus === "review")
        return status({ rank: RANK.review, tone: "review", group: "review", label: "已交付·待验收", needsHuman: false, title: `已空闲，卡 ${session.taskCode} 在待验收` });
      return status({ rank: RANK.idle, tone: "idle", group: "available", label: "空闲·可派活", needsHuman: false });
    case "gone":
      return session.taskStatus === "doing"
        ? status({ rank: RANK.gone_doing, tone: "bad", group: "attention", label: "会话已离开，卡仍在进行中", needsHuman: true })
        : status({ rank: RANK.gone, tone: "gone", group: "other", label: "会话已离开", needsHuman: false });
    default: return status({ rank: RANK.unknown, tone: "offline", group: ALERT.has(session.state) ? "attention" : "other", label: session.state, needsHuman: ALERT.has(session.state) });
  }
}

/**
 * Fallback when there is no live data: classify by the Lead's hand-written 「当前在做」, same rule
 * the roster page always used, and say it is hand-written.
 */
export function rosterStatus(member: Pick<TeamMember, "currentTask">, lead = false): LiveStatus {
  const activity = memberActivity(member);
  const group: StatusGroup = lead ? "lead" : activity === "working" ? "rosterWorking" : activity === "idle" ? "rosterIdle" : "rosterUnknown";
  const rank = lead ? RANK.lead : { working: 20, idle: 21, unknown: 22 }[activity];
  return { rank, group, tone: activity === "working" ? "run" : "none", label: memberActivityLabels[activity] + "（手写）", needsHuman: false, duration: "", title: "看板实时状态不可用，按 Lead 手写的「当前在做」显示，可能过期" };
}

/** Lead 备注 age; older than a day is flagged as possibly stale. */
export const NOTE_STALE_MS = 24 * 3600_000;
export function noteFreshness(updatedAt: string | undefined, nowMs = Date.now()): { age: string; stale: boolean } {
  const at = Date.parse(updatedAt ?? "");
  if (!updatedAt || Number.isNaN(at)) return { age: "更新时间未知", stale: true };
  return { age: formatAge(updatedAt, nowMs) + "前", stale: nowMs - at > NOTE_STALE_MS };
}

/** The Lead: role starting with 「Lead」, or the very tmux session the team panel is bound to. */
export function isLeadMember(m: Pick<TeamMember, "role" | "tmux" | "workdir" | "username">, self?: { tmuxId: string; tmuxCreated: number; workdir: string; username: string }) {
  return /^lead\b/i.test(m.role.trim()) || (!!self && m.tmux.id === self.tmuxId && m.tmux.created === self.tmuxCreated && m.workdir === self.workdir && m.username === self.username);
}

type Matchable = Pick<TeamMember, "host" | "workdir" | "email" | "tmux" | "currentTask">;
/** Live data is used only while the board answers; an offline board falls back to the roster's hand-written state. */
export const liveSnapshot = (live: Pick<LiveSessions, "snapshot" | "offline"> | undefined) => (live && !live.offline ? live.snapshot : undefined);

/**
 * Members with their status, most urgent first — the single source both team pages render.
 * With a snapshot: live status. Without one (offline / not configured / first load): hand-written
 * fallback. Within 「需要处理」, 「等 Lead」 and 「待验收」 the longest-waiting comes first; otherwise
 * roster order is kept.
 */
export function rankMembers<M extends Matchable>(members: M[], snapshot: SessionsSnapshot | undefined, isLead: (m: M) => boolean = () => false) {
  return members
    .map((member, index) => {
      const lead = isLead(member);
      const session = snapshot ? matchSession(member, snapshot.sessions) : undefined;
      const status: LiveStatus = snapshot ? liveStatus(session, snapshot.now, snapshot.ttlSeconds, lead) : rosterStatus(member, lead);
      return { member, session, status, index };
    })
    .sort((a, b) => a.status.rank - b.status.rank
      || (a.status.group === b.status.group && WAITING_GROUPS.has(a.status.group) ? (a.session?.stateSince ?? 0) - (b.session?.stateSince ?? 0) : 0)
      || a.index - b.index);
}
const WAITING_GROUPS: ReadonlySet<StatusGroup> = new Set(["attention", "waitLead", "review"]);

export interface TeamSummary {
  live: boolean;
  attention: number;
  waitLead: number;
  /** 「3 小时」, longest current 「等 Lead」 wait; empty when nobody waits. */
  longestWaitLead: string;
  review: number;
  available: number;
}
/** Top-of-panel counts. Leads are not counted. Without live data only `live: false` is meaningful. */
export function summarizeTeam(ranked: { status: LiveStatus; session?: AgentSession }[], snapshot: SessionsSnapshot | undefined): TeamSummary {
  const of = (g: StatusGroup) => ranked.filter(r => r.status.group === g);
  const waiting = of("waitLead");
  const oldest = Math.min(...waiting.map(r => r.session?.stateSince || Infinity));
  return {
    live: !!snapshot, attention: of("attention").length, waitLead: waiting.length,
    longestWaitLead: snapshot && Number.isFinite(oldest) ? ago(oldest, snapshot.now) : "",
    review: of("review").length, available: of("available").length,
  };
}

/**
 * Cards worth a brief lookup: those of matched sessions that are live, or gone with the card still
 * in progress. Keyed by the session's own board project, which may differ from the dssh team name.
 */
export function briefTargets(sessions: (AgentSession | undefined)[]): { project: string; code: string }[] {
  const seen = new Map<string, { project: string; code: string }>();
  for (const s of sessions)
    if (s?.taskCode && isIdentifier(s.taskCode) && isIdentifier(s.project) && (s.state !== "gone" || s.taskStatus === "doing"))
      seen.set(briefKey(s.project, s.taskCode), { project: s.project, code: s.taskCode });
  return [...seen.values()];
}
export const briefKey = (project: string, code: string) => `${project}/${code}`;

// ---------- transport ----------
export const SESSION_REFRESH_MS = 60_000;

/** All sessions the collector knows, across projects: members are matched by tmux name, not by project slug. */
export async function fetchAgentSessions(source: BoardSource): Promise<SessionsSnapshot> {
  const data = await get<unknown>(source, "/api/v1/agent-sessions");
  if (data === null) throw new BoardError("unreachable", "看板不支持会话采集（/api/v1/agent-sessions 返回 404）");
  return parseAgentSessions(data);
}
/** One task's 「一句话」(brief) and title; cached 5 minutes like the rest of the board lookups. */
export function taskBrief(source: BoardSource, project: string, code: string): Promise<TaskBrief | null> {
  return cached(`${source.key}|brief|${project}|${code}`, async () => {
    const raw = await get<Record<string, unknown>>(source, `/api/v1/projects/${project}/tasks/${code}`);
    return raw && typeof raw.code === "string" ? { code: raw.code, title: str(raw.title), brief: str(raw.brief) } : null;
  });
}

/** One task's lifecycle for the temporary-worker badge: only the board's done column matters. */
export function taskLifecycle(source: BoardSource, project: string, code: string): Promise<"done" | "open" | null> {
  if (!isIdentifier(project) || !isIdentifier(code)) return Promise.resolve(null);
  return cached(`${source.key}|lifecycle|${project}|${code}`, async () => {
    const raw = await get<Record<string, unknown>>(source, `/api/v1/projects/${project}/tasks/${code}`);
    return raw && typeof raw.status_key === "string" ? (raw.status_key === "done" ? "done" : "open") : null;
  });
}

export interface LiveSessions {
  snapshot?: SessionsSnapshot;
  /** `briefKey(project, code)` → brief. */
  briefs: Record<string, TaskBrief>;
  /** `briefKey(project, statusKey)` → display name of that board column. */
  statusNames: Record<string, string>;
  /** Last refresh failed; `snapshot` (if any) is from `fetchedAt`. */
  offline: boolean;
  error: string;
  fetchedAt?: number;
}
const empty = (): LiveSessions => ({ briefs: {}, statusNames: {}, offline: false, error: "" });
/**
 * Poll the collector every minute while mounted (skipped while the window is hidden); the timer
 * dies with the component. Briefs and status names are fetched for the given members' cards only.
 */
export function useAgentSessions(source: BoardSource | undefined, members: Pick<TeamMember, "host" | "workdir" | "email" | "tmux">[], interval = SESSION_REFRESH_MS): LiveSessions {
  const [state, setState] = useState<LiveSessions>(empty);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const key = source?.key ?? "";
  useEffect(() => {
    setState(empty());
    if (!key) return;
    let live = true;
    const refresh = async () => {
      const current = sourceRef.current;
      if (!current || document.hidden) return;
      try {
        const snapshot = await fetchAgentSessions(current);
        if (live) setState(prev => ({ ...prev, snapshot, offline: false, error: "", fetchedAt: Date.now() }));
      } catch (e) {
        if (live) setState(prev => ({ ...prev, offline: true, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), interval);
    return () => { live = false; window.clearInterval(timer); };
  }, [key, interval]);
  const targets = state.snapshot ? briefTargets(members.map(m => matchSession(m, state.snapshot!.sessions))) : [];
  const targetsKey = JSON.stringify(targets);
  useEffect(() => {
    const current = sourceRef.current;
    if (!current || !targets.length) return;
    let live = true;
    void (async () => {
      const projects = [...new Set(targets.map(t => t.project))];
      const [statuses, found] = await Promise.all([
        Promise.allSettled(projects.map(p => listStatuses(current, p))),
        Promise.allSettled(targets.map(t => taskBrief(current, t.project, t.code))),
      ]);
      if (!live) return;
      const statusNames: Record<string, string> = {};
      statuses.forEach((r, i) => { if (r.status === "fulfilled") for (const s of r.value) statusNames[briefKey(projects[i], s.key)] = s.name; });
      const briefs: Record<string, TaskBrief> = {};
      found.forEach((r, i) => { if (r.status === "fulfilled" && r.value) briefs[briefKey(targets[i].project, targets[i].code)] = r.value; });
      setState(prev => ({ ...prev, briefs: { ...prev.briefs, ...briefs }, statusNames: { ...prev.statusNames, ...statusNames } }));
    })();
    return () => { live = false; };
  }, [key, targetsKey, state.fetchedAt]);
  return state;
}
