import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { collaborationKey, type CollaborationProfile } from "./collaboration";
import type { SessionInfo } from "../types";

/** Read-only taskboard lookups: find a task by project + code, index codes for the terminal. */

export type BoardRoute =
  | { kind: "direct"; url: string }
  | { kind: "ssh"; sessionId: string; profile: CollaborationProfile };
export interface BoardSource {
  route: BoardRoute;
  /** Cache key: one board, regardless of which session reaches it. */
  key: string;
  /** Web board base URL for 「在看板中打开」. */
  webUrl: string;
  label: string;
}
export interface IndexTask { code: string; title: string; status_key: string; assignee: string; updated_at: string }
export interface BoardTask extends IndexTask {
  summary: string; detail: string; acceptance: string; blocked_reason: string;
  status_changed_at: string; created_at: string;
}
export interface BoardStatus { key: string; name: string; color: string }
export interface BoardDependency { code: string; title: string; status_key: string; completed: boolean }
export interface BoardProject { slug: string; name: string; archived?: boolean }
export interface TaskIndex { project: string; tasks: IndexTask[]; byCode: Map<string, IndexTask>; fetchedAt: number }

export type BoardErrorKind = "config" | "unreachable" | "project" | "task" | "format" | "input";
export class BoardError extends Error {
  constructor(public kind: BoardErrorKind, message: string) { super(message); }
}

// ---------- settings ----------
export interface TaskLookupSettings {
  /** Board base URL reachable from this desktop. Empty: use the session's collaboration binding. */
  boardUrl: string;
  /** Recognise task codes in terminal output. */
  terminalLinks: boolean;
  /** Project locked in the team panel; empty when unlocked. */
  lockedProject: string;
  /** Manual project per `server:<id>` or `tmux:<serverId>:<session name>`. */
  overrides: Record<string, string>;
}
export const TASK_LOOKUP_KEY = "dssh.task-lookup.v1";
const EVENT = "dssh-task-lookup-changed";
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const isIdentifier = (value: string) => identifier.test(value);
export const defaultLookupSettings = (): TaskLookupSettings => ({ boardUrl: "", terminalLinks: true, lockedProject: "", overrides: {} });

export function boardUrlError(value: string): string {
  if (!value.trim()) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error();
    return "";
  } catch { return "请填写不含凭据或查询参数的 HTTP(S) 看板地址"; }
}
export function loadLookupSettings(): TaskLookupSettings {
  const settings = defaultLookupSettings();
  try {
    const raw = JSON.parse(localStorage.getItem(TASK_LOOKUP_KEY) ?? "{}") as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return settings;
    if (typeof raw.boardUrl === "string" && !boardUrlError(raw.boardUrl)) settings.boardUrl = raw.boardUrl.trim();
    if (typeof raw.terminalLinks === "boolean") settings.terminalLinks = raw.terminalLinks;
    if (typeof raw.lockedProject === "string" && isIdentifier(raw.lockedProject)) settings.lockedProject = raw.lockedProject;
    if (raw.overrides && typeof raw.overrides === "object" && !Array.isArray(raw.overrides))
      for (const [key, value] of Object.entries(raw.overrides as Record<string, unknown>))
        if (typeof value === "string" && isIdentifier(value) && /^(server|tmux):/.test(key)) settings.overrides[key] = value;
  } catch { /* corrupt settings fall back to defaults */ }
  return settings;
}
export function saveLookupSettings(patch: Partial<TaskLookupSettings>): TaskLookupSettings {
  const next = { ...loadLookupSettings(), ...patch };
  const error = boardUrlError(next.boardUrl);
  if (error) throw new Error(error);
  if (next.lockedProject && !isIdentifier(next.lockedProject)) throw new Error("项目编号格式无效");
  next.boardUrl = next.boardUrl.trim();
  localStorage.setItem(TASK_LOOKUP_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(EVENT));
  return next;
}
export function useLookupSettings(): TaskLookupSettings {
  const [settings, setSettings] = useState(loadLookupSettings);
  useEffect(() => {
    const update = () => setSettings(loadLookupSettings());
    window.addEventListener(EVENT, update); window.addEventListener("storage", update);
    return () => { window.removeEventListener(EVENT, update); window.removeEventListener("storage", update); };
  }, []);
  return settings;
}
export const serverOverrideKey = (serverId: string) => `server:${serverId}`;
export const tmuxOverrideKey = (serverId: string, tmuxName: string) => `tmux:${serverId}:${tmuxName}`;

// ---------- which board, which project ----------
/**
 * The desktop URL wins when configured. Otherwise a tmux binding with the task board enabled
 * is queried from its SSH server, as the existing collaboration panel does. No silent fallback.
 */
export function boardSource(settings: TaskLookupSettings, profile?: CollaborationProfile, sessionId?: string): BoardSource | undefined {
  if (settings.boardUrl && !boardUrlError(settings.boardUrl)) {
    const url = settings.boardUrl.replace(/\/+$/, "");
    return { route: { kind: "direct", url }, key: `direct:${url}`, webUrl: url, label: `本机直连 ${url}` };
  }
  if (profile?.enabled && profile.taskboardEnabled && sessionId && !boardUrlError(profile.taskboardUrl) && profile.taskboardUrl) {
    const url = profile.taskboardUrl.replace(/\/+$/, "");
    return { route: { kind: "ssh", sessionId, profile }, key: `ssh:${url}`, webUrl: url, label: `经 SSH 服务器访问 ${url}` };
  }
  return undefined;
}
export const NO_SOURCE = "未配置看板地址：在「设置 → 任务查询」填写本机可访问的看板地址，或在「设置 → Agent 协作」为此 tmux 会话开启任务看板。";

export type ProjectReason = "locked" | "collaboration" | "tmux" | "server";
export const projectReasonLabel: Record<ProjectReason, string> = {
  locked: "团队面板锁定", collaboration: "Agent 协作绑定", tmux: "手动指定（tmux 会话）", server: "手动指定（服务器）",
};
/** Collaboration bindings that belong to this pane's tmux incarnation. */
export function paneProfiles(profiles: Record<string, CollaborationProfile>, pane?: SessionInfo): CollaborationProfile[] {
  if (!pane?.tmux) return [];
  return Object.entries(profiles).filter(([key, p]) => p.enabled && key === collaborationKey(pane.server.id, p) && p.tmuxId === pane.tmux!.id && p.tmuxCreated === pane.tmux!.created).map(([, p]) => p);
}
/**
 * Project of a terminal: the locked project first, then this session's collaboration binding
 * (the verified worktree when known; otherwise only when all bindings agree), then a manual
 * per-session or per-server choice. Undefined disables terminal code recognition.
 */
export function inferProject(settings: TaskLookupSettings, pane: SessionInfo | undefined, profiles: Record<string, CollaborationProfile>, verified?: CollaborationProfile): { project: string; reason: ProjectReason } | undefined {
  if (settings.lockedProject) return { project: settings.lockedProject, reason: "locked" };
  if (!pane) return undefined;
  if (verified?.enabled && isIdentifier(verified.project)) return { project: verified.project, reason: "collaboration" };
  const projects = [...new Set(paneProfiles(profiles, pane).map(p => p.project).filter(isIdentifier))];
  if (projects.length === 1) return { project: projects[0], reason: "collaboration" };
  const tmux = pane.tmux ? settings.overrides[tmuxOverrideKey(pane.server.id, pane.tmux.name)] : undefined;
  if (tmux) return { project: tmux, reason: "tmux" };
  const server = settings.overrides[serverOverrideKey(pane.server.id)];
  if (server) return { project: server, reason: "server" };
  return undefined;
}

// ---------- transport + cache ----------
const TTL = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();
export function clearBoardCache() { cache.clear(); }
function cached<T>(key: string, load: () => Promise<T>, force = false, ttl = TTL): Promise<T> {
  const hit = cache.get(key);
  if (hit && !force && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}
async function get<T>(source: BoardSource, path: string, index = false): Promise<T | null> {
  let response: { status: number; body: string };
  try { response = await invoke("taskboard_get", { route: source.route, path, index }); }
  catch (e) { throw new BoardError("unreachable", String(e).startsWith("看板") ? String(e) : `看板不可达：${String(e)}`); }
  if (response.status === 404) return null;
  if (response.status !== 200) throw new BoardError("unreachable", `看板返回 HTTP ${response.status}`);
  try { return JSON.parse(response.body) as T; }
  catch { throw new BoardError("format", "看板返回格式无效"); }
}
const str = (value: unknown) => (value == null ? "" : String(value));
const slugPath = (project: string) => `/api/v1/projects/${project}`;

export function listProjects(source: BoardSource, force = false): Promise<BoardProject[]> {
  return cached(`${source.key}|projects`, async () => {
    const data = await get<{ projects?: unknown }>(source, "/api/v1/projects");
    if (!data || !Array.isArray(data.projects)) throw new BoardError("format", "看板返回格式无效");
    return data.projects.filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { slug?: unknown }).slug === "string")
      .map(p => ({ slug: str(p.slug), name: str(p.name) || str(p.slug), archived: p.archived === true }));
  }, force);
}
export function listStatuses(source: BoardSource, project: string): Promise<BoardStatus[]> {
  return cached(`${source.key}|statuses|${project}`, async () => {
    const data = await get<{ statuses?: unknown }>(source, `${slugPath(project)}/statuses`);
    if (!data || !Array.isArray(data.statuses)) return [];
    return data.statuses.map(s => s as Record<string, unknown>).map(s => ({ key: str(s.key), name: str(s.name) || str(s.key), color: /^#[0-9a-fA-F]{3,8}$/.test(str(s.color)) ? str(s.color) : "" }));
  });
}
export function buildIndex(project: string, tasks: IndexTask[], fetchedAt = Date.now()): TaskIndex {
  return { project, tasks, byCode: new Map(tasks.map(t => [t.code, t])), fetchedAt };
}
export function taskIndex(source: BoardSource, project: string, force = false): Promise<TaskIndex> {
  if (!isIdentifier(project)) return Promise.reject(new BoardError("input", "项目编号格式无效"));
  return cached(`${source.key}|index|${project}`, async () => {
    const data = await get<{ tasks?: unknown }>(source, `${slugPath(project)}/tasks`, true);
    if (!data || !Array.isArray(data.tasks)) throw new BoardError("format", "看板返回格式无效");
    const tasks = data.tasks.map(t => t as Record<string, unknown>).filter(t => typeof t.code === "string" && isIdentifier(t.code))
      .map(t => ({ code: str(t.code), title: str(t.title), status_key: str(t.status_key), assignee: str(t.assignee), updated_at: str(t.updated_at) }));
    return buildIndex(project, tasks);
  }, force);
}

// ---------- parsing & matching ----------
export interface LookupQuery { project?: string; code: string }
/** 「项目 编号」「项目/编号」 or just 「编号」. */
export function parseQuery(input: string): LookupQuery {
  const parts = input.trim().split(/[\s/]+/).filter(Boolean);
  if (!parts.length) throw new BoardError("input", "请输入任务编号，例如 T1090 或 smart-table T1090");
  if (parts.length > 2) throw new BoardError("input", "格式：编号，或「项目 编号」");
  const [project, code] = parts.length === 2 ? parts : [undefined, parts[0]];
  if (project !== undefined && !isIdentifier(project)) throw new BoardError("input", "项目编号格式无效");
  if (!isIdentifier(code)) throw new BoardError("input", "任务编号只能包含字母、数字、点、下划线或连字符");
  return { project, code };
}
/**
 * Exact (case-insensitive) match first. Otherwise complete an omitted prefix:
 * 「1090」→ T1090, 「42」→ AM-42, 「RETRY-403-GAP」→ DD-RETRY-403-GAP. Several candidates are all returned.
 */
export function resolveCode(input: string, tasks: IndexTask[]): IndexTask[] {
  const wanted = input.trim().toUpperCase();
  if (!wanted) return [];
  const exact = tasks.filter(t => t.code.toUpperCase() === wanted);
  if (exact.length) return exact;
  return tasks.filter(t => {
    const code = t.code.toUpperCase();
    if (!code.endsWith(wanted) || code.length === wanted.length) return false;
    const before = code[code.length - wanted.length - 1];
    // Boundary: a separator, or letters followed by the digits typed.
    return /[-._]/.test(before) || (/^\d/.test(wanted) && /[A-Z]/.test(before));
  }).sort((a, b) => a.code.length - b.code.length || a.code.localeCompare(b.code));
}

export interface CodeMatch { start: number; end: number; code: string }
const TOKEN = /[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/g;
const MAX_LINE = 4096;
/**
 * Find codes that exist on the board. Only whole tokens or separator-aligned parts of a token
 * match (「T1090」「T1090:」「fix-T1090」), never the middle of a word (「AT1090」).
 * `end` is exclusive. Case-sensitive, like the board.
 */
export function findTaskCodes(text: string, has: (code: string) => boolean): CodeMatch[] {
  const matches: CodeMatch[] = [];
  const line = text.length > MAX_LINE ? text.slice(0, MAX_LINE) : text;
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(line); m; m = TOKEN.exec(line)) {
    const token = m[0];
    if (token.length <= 64 && has(token)) { matches.push({ start: m.index, end: m.index + token.length, code: token }); continue; }
    const segments: { start: number; end: number }[] = [];
    const part = /[A-Za-z0-9]+/g;
    for (let s = part.exec(token); s; s = part.exec(token)) segments.push({ start: s.index, end: s.index + s[0].length });
    if (segments.length < 2 || segments.length > 12) continue;
    for (let i = 0; i < segments.length;) {
      let found = 0;
      for (let j = segments.length; j > i; j--) {
        if (i === 0 && j === segments.length) continue;
        const code = token.slice(segments[i].start, segments[j - 1].end);
        if (code.length <= 64 && has(code)) {
          matches.push({ start: m.index + segments[i].start, end: m.index + segments[j - 1].end, code });
          found = j; break;
        }
      }
      i = found || i + 1;
    }
  }
  return matches;
}

// ---------- display rules (same as the web board) ----------
/** Drop 「@…」, then the longest known 「<project>-」 prefix. */
export function shortName(assignee: string, slugs: string[]): string {
  const full = assignee.trim();
  if (!full) return "";
  let name = full.replace(/@.*$/, "").trim() || full;
  for (const slug of [...slugs].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (name.toLowerCase().startsWith(slug.toLowerCase() + "-") && name.length > slug.length + 1) { name = name.slice(slug.length + 1); break; }
  }
  return name;
}
export function formatAge(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (!iso || Number.isNaN(at)) return "未知";
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
/** The web board has no per-task link; `?project=` opens the right project. */
export function boardLink(source: BoardSource, project: string): string {
  return `${source.webUrl.replace(/\/+$/, "")}/?project=${encodeURIComponent(project)}`;
}
export function openBoard(url: string): Promise<void> { return invoke("taskboard_open", { url }); }

// ---------- lookups ----------
export interface TaskCardData {
  project: string; task: BoardTask; status?: BoardStatus; statuses: BoardStatus[];
  dependencies: (BoardDependency & { status?: BoardStatus })[]; slugs: string[];
}
export type LookupResult =
  | { kind: "task"; card: TaskCardData }
  | { kind: "choices"; code: string; choices: { project: string; task: IndexTask }[] };

async function ensureProject(source: BoardSource, project: string): Promise<BoardProject[]> {
  const projects = await listProjects(source);
  if (!projects.some(p => p.slug === project)) throw new BoardError("project", `看板上没有项目「${project}」`);
  return projects;
}
export async function loadCard(source: BoardSource, project: string, code: string): Promise<TaskCardData> {
  const projects = await ensureProject(source, project);
  const base = `${slugPath(project)}/tasks/${code}`;
  const [raw, deps, statuses] = await Promise.all([
    get<Record<string, unknown>>(source, base),
    get<{ dependencies?: unknown }>(source, `${base}/dependencies`),
    listStatuses(source, project).catch(() => [] as BoardStatus[]),
  ]);
  if (!raw || typeof raw.code !== "string") throw new BoardError("task", `项目「${project}」中没有编号「${code}」`);
  const task: BoardTask = {
    code: str(raw.code), title: str(raw.title), status_key: str(raw.status_key), assignee: str(raw.assignee), updated_at: str(raw.updated_at),
    summary: str(raw.summary), detail: str(raw.detail), acceptance: str(raw.acceptance), blocked_reason: str(raw.blocked_reason),
    status_changed_at: str(raw.status_changed_at), created_at: str(raw.created_at),
  };
  const byKey = new Map(statuses.map(s => [s.key, s]));
  const dependencies = (Array.isArray(deps?.dependencies) ? deps!.dependencies : []).map(d => d as Record<string, unknown>)
    .filter(d => typeof d.code === "string")
    .map(d => ({ code: str(d.code), title: str(d.title), status_key: str(d.status_key), completed: d.completed === true, status: byKey.get(str(d.status_key)) }));
  return { project, task, status: byKey.get(task.status_key), statuses, dependencies, slugs: projects.map(p => p.slug) };
}
/**
 * With a project (typed or current): resolve the code in that project, completing an omitted
 * prefix. Without one: exact code match across every project; several hits become choices.
 */
export async function lookupTask(source: BoardSource, input: string, currentProject?: string): Promise<LookupResult> {
  const query = parseQuery(input);
  const project = query.project ?? currentProject;
  if (project) {
    await ensureProject(source, project);
    const index = await taskIndex(source, project);
    const matches = resolveCode(query.code, index.tasks);
    if (matches.length > 1) return { kind: "choices", code: query.code, choices: matches.slice(0, 50).map(task => ({ project, task })) };
    // Not in the index (possibly created in the last few minutes): ask the board directly.
    return { kind: "task", card: await loadCard(source, project, matches[0]?.code ?? query.code) };
  }
  const projects = await listProjects(source);
  const results = await Promise.allSettled(projects.map(p => taskIndex(source, p.slug)));
  if (results.length && results.every(r => r.status === "rejected")) throw (results[0] as PromiseRejectedResult).reason;
  const wanted = query.code.toUpperCase();
  const choices = results.flatMap((r, i) => r.status === "fulfilled" ? r.value.tasks.filter(t => t.code.toUpperCase() === wanted).map(task => ({ project: projects[i].slug, task })) : []);
  if (!choices.length) throw new BoardError("task", `所有项目中都没有编号「${query.code}」`);
  if (choices.length === 1) return { kind: "task", card: await loadCard(source, choices[0].project, choices[0].task.code) };
  return { kind: "choices", code: query.code, choices };
}

/** Code index of one project for the terminal; refreshed every 5 minutes while visible. */
export function useTaskIndex(source: BoardSource | undefined, project: string | undefined, enabled: boolean): TaskIndex | undefined {
  const [index, setIndex] = useState<TaskIndex>();
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const key = enabled && source && project ? `${source.key}|${project}` : "";
  useEffect(() => {
    setIndex(undefined);
    if (!key || !project) return;
    let live = true;
    // Panes share the module cache, so one project costs one request per TTL however many panes show it.
    const refresh = () => {
      const current = sourceRef.current;
      if (!current || document.hidden) return;
      taskIndex(current, project).then(value => { if (live) setIndex(prev => prev?.fetchedAt === value.fetchedAt && prev.project === value.project ? prev : value); }).catch(() => { /* keep the last index */ });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [key]);
  return index;
}
