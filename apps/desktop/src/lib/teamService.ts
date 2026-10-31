import { useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { parseMember, memberKey, type TeamMember } from './teamMembers';

export type TeamConnectionState = 'connecting' | 'online' | 'offline' | 'unauthorized' | 'error';
export interface TeamServiceStatus {
  state: TeamConnectionState;
  token_configured: boolean;
  ai_enabled?: boolean | null;
  since?: number;
  code?: string;
}
export interface ServiceLive {
  key: string;
  match: 'exact' | 'replaced' | 'gone' | 'no_agent';
  state: 'running' | 'waiting_input' | 'input_pending' | 'stuck' | 'idle' | 'unknown';
  detail: string;
  machine?: string | null;
  session?: string | null;
  since?: string;
  at?: string;
  ctx_pct?: number | null;
  model?: string;
  last_line?: string;
  branch?: string;
  stale?: boolean;
}
export type TeamLive = ServiceLive;
export interface TeamServiceProject {
  project: string;
  seq: number;
  lseq: number;
  members: TeamMember[];
  ai: Record<string, unknown>;
  live: Record<string, ServiceLive>;
  machines: Record<string, unknown>;
  receivedAt: number | null;
  offline: boolean;
  status: TeamConnectionState;
  identity: string;
  /** Human-readable project title when the team service provides one. */
  title?: string;
}
export interface ProjectCatalog { state: "unknown" | "ready" | "error"; projects: string[]; message?: string }
export interface TeamServiceState {
  catalog?: ProjectCatalog;
  url: string;
  projects: string[];
  status: TeamServiceStatus;
  snapshots: Record<string, TeamServiceProject>;
}
export const TEAM_SERVICE_CONFIG = 'dssh.team-service.config.v1';
export const TEAM_SERVICE_CACHE = 'dssh.team-service.cache.v1';
const projectPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sequence = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function normalizeServiceUrl(input: string): string {
  const url = new URL(input);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('团队服务地址无效');
  }
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/api/v1/team/ws')) path = path.slice(0, -8);
  if (!path.endsWith('/api/v1')) path += '/api/v1';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}
export const serviceProjectIdentity = (url: string, project: string) => JSON.stringify([url, project]);
function projectsOf(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 64 || value.some(p => typeof p !== 'string' || !projectPattern.test(p))) throw Error('项目编号无效');
  return [...new Set(value as string[])];
}
function savedJson(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; }
}
function initialState(): TeamServiceState {
  let url = '', projects: string[] = [];
  const config = savedJson(TEAM_SERVICE_CONFIG);
  if (object(config)) {
    try { url = normalizeServiceUrl(String(config.url)); projects = projectsOf(config.projects); } catch { /* Invalid saved configuration is ignored. */ }
  }
  return { url, projects, catalog: {state: "unknown", projects: []}, status: { state: 'offline', token_configured: false }, snapshots: {} };
}
let current = initialState();
const observers = new Set<() => void>();
let unlisten: UnlistenFn[] = [];
let starting: Promise<void> | undefined;
let lifetime = 0;
let identityGeneration = 0;
let catalogRevision = 0;
let capabilityRevision = 0;
let configuring = false;
let revision = 0;
const projectRevisions = new Map<string, number>();
let pulling: Promise<void> | undefined;
let pullAgain = false;
function publish(next: TeamServiceState) {
  current = next;
  revision++;
  for (const observer of observers) observer();
}
function persist() {
  try {
    localStorage.setItem(TEAM_SERVICE_CONFIG, JSON.stringify({ url: current.url, projects: current.projects }));
    localStorage.setItem(TEAM_SERVICE_CACHE, JSON.stringify({ url: current.url,
      snapshots: Object.fromEntries(Object.entries(current.snapshots).map(([key, p]) => [key, {
        project: p.project, seq: p.seq, members: p.members, ai: p.ai, receivedAt: p.receivedAt,
      }])) }));
  } catch { /* State remains available in memory when local persistence is unavailable. */ }
}
function statusOf(value: unknown): TeamServiceStatus | undefined {
  if (!object(value) || !['connecting', 'online', 'offline', 'unauthorized', 'error'].includes(String(value.state))) return;
  return { state: value.state as TeamConnectionState, token_configured: value.token_configured === true,
    ...(typeof value.since === 'number' ? { since: value.since } : {}),
    ...(typeof value.code === 'string' ? { code: value.code } : {}) };
}
function liveMap(value: unknown): Record<string, ServiceLive> {
  if (!object(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => object(item) &&
    typeof item.key === 'string' && ['exact', 'replaced', 'gone', 'no_agent'].includes(String(item.match)) &&
    ['running', 'waiting_input', 'input_pending', 'stuck', 'idle', 'unknown'].includes(String(item.state)))) as Record<string, ServiceLive>;
}
function snapshotOf(value: unknown, url: string, status: TeamServiceStatus, historical = false): TeamServiceProject | undefined {
  if (!object(value) || typeof value.project !== 'string' || !projectPattern.test(value.project) ||
      !sequence(value.seq) || !Array.isArray(value.members) || value.members.length > 100 || !object(value.ai)) return;
  try {
    const members = value.members.map(member => parseMember(member, value.project as string));
    if (new Set(members.map(memberKey)).size !== members.length) return;
    const old = current.url === url ? current.snapshots[value.project] : undefined;
    // Legacy cached snapshots have no timestamp. Never invent one for cached data.
    const savedAt = typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : null;
    const cachedTime = savedAt ?? (typeof value.receivedAt === 'number' && Number.isFinite(value.receivedAt) ? value.receivedAt :
      old?.seq === value.seq ? old.receivedAt : null);
    const cached = historical || value.offline === true;
    const offline = status.state !== 'online';
    const title = typeof value.title === "string" && value.title.trim() ? value.title.trim()
      : typeof value.display_name === "string" && value.display_name.trim() ? value.display_name.trim() : undefined;
    return { project: value.project, seq: value.seq, lseq: sequence(value.lseq) ? value.lseq : 0,
      members, ai: value.ai, live: liveMap(value.live), machines: object(value.machines) ? value.machines : {},
      receivedAt: savedAt ?? (cached || offline ? cachedTime : Date.now()), offline, status: status.state,
      identity: serviceProjectIdentity(url, value.project), ...(title ? { title } : {}) };
  } catch { return; }
}
function loadCache() {
  const cache = savedJson(TEAM_SERVICE_CACHE);
  if (!object(cache) || cache.url !== current.url || !object(cache.snapshots)) return;
  const snapshots: Record<string, TeamServiceProject> = {};
  for (const project of current.projects) {
    const snapshot = snapshotOf(cache.snapshots[project], current.url, current.status, true);
    if (snapshot) snapshots[project] = snapshot;
  }
  current = { ...current, snapshots };
}
loadCache();
function applyStatus(status: TeamServiceStatus) {
  const becameOnline = status.state === "online" && current.status.state !== "online";
  const reconnect = status.state === 'connecting';
  publish({ ...current, status: { ...status, ai_enabled: status.ai_enabled ?? current.status.ai_enabled }, snapshots: Object.fromEntries(Object.entries(current.snapshots).map(([p, snapshot]) => [p,
    { ...snapshot, status: status.state, offline: status.state !== 'online', ...(reconnect ? { lseq: -1 } : {}) }])) });
  if (becameOnline) void refreshProjectCatalog();
}
function eventReceived(event: unknown) {
  if (configuring || !object(event)) return;
  const status = statusOf(event);
  if (status && !event.type) { applyStatus(status); return; }
  const project = typeof event.project === 'string' ? event.project : '';
  if (event.type === 'machine') {
    if (typeof event.name !== 'string') return;
    if (pulling) pullAgain = true;
    const machine = { name: event.name, online: event.online, seen: event.seen, version: event.version };
    for (const project of Object.keys(current.snapshots)) projectRevisions.set(project, revision + 1);
    publish({ ...current, snapshots: Object.fromEntries(Object.entries(current.snapshots).map(([key, p]) =>
      [key, { ...p, machines: { ...p.machines, [event.name as string]: machine } }])) });
    return;
  }
  if (!current.projects.includes(project)) return;
  const old = current.snapshots[project];
  let next: TeamServiceProject | undefined;
  if (event.type === 'snapshot') {
    next = snapshotOf(event, current.url, current.status);
  } else if (event.type === 'delta') {
    if (!sequence(event.seq) || !Array.isArray(event.ops)) return;
    if (!old || event.seq > old.seq + 1) { void pull(true); return; }
    if (event.seq <= old.seq) return;
    const members = new Map(old.members.map(m => [memberKey(m), m]));
    const ai = { ...old.ai }, live = { ...old.live };
    try {
      for (const operation of event.ops) {
        if (!object(operation)) throw Error();
        if (operation.op === 'upsert') {
          const member = parseMember(operation.member, project); members.set(memberKey(member), member);
        } else if (operation.op === 'remove' && typeof operation.key === 'string') {
          members.delete(operation.key); delete ai[operation.key]; delete live[operation.key];
        } else if (operation.op === 'ai' && typeof operation.key === 'string') {
          if (operation.ai === null) delete ai[operation.key];
          else if (object(operation.ai)) ai[operation.key] = operation.ai;
          else throw Error();
        } else throw Error();
      }
      if (members.size > 100) throw Error();
      next = { ...old, seq: event.seq, members: [...members.values()], ai, live,
        receivedAt: typeof event.savedAt === 'number' ? event.savedAt : Date.now(), offline: current.status.state !== 'online', status: current.status.state };
    } catch { void pull(true); return; }
  } else if (event.type === 'live') {
    if (!old || !sequence(event.lseq) || event.lseq <= old.lseq || typeof event.full !== 'boolean' || !Array.isArray(event.items)) return;
    const items = Object.fromEntries(event.items.filter(object).filter(v => typeof v.key === 'string').map(v => [v.key, v]));
    next = { ...old, lseq: event.lseq, live: { ...(event.full ? {} : old.live), ...liveMap(items) } };
  }
  if (next) {
    projectRevisions.set(project, revision + 1);
    publish({ ...current, snapshots: { ...current.snapshots, [project]: next } });
    if (event.type !== 'live') persist();
  }
}
async function pull(retryAfterPending = false, restore = false) {
  if (pulling) { if (retryAfterPending) pullAgain = true; return pulling; }
  const generation = identityGeneration, at = revision, perProject = new Map(projectRevisions);
  const task = (async () => {
    try {
      const reply = await invoke<unknown>('team_service_read');
      if (generation !== identityGeneration || configuring || !object(reply)) return;
      const status = at === revision ? {...(statusOf(reply.status) ?? current.status), ai_enabled: current.status.ai_enabled} : current.status;
      let url = current.url;
      if (typeof reply.url === 'string') url = normalizeServiceUrl(reply.url);
      if (current.url && url !== current.url && !restore) return;
      const projects = projectsOf(reply.projects);
      const sameUrl = current.url === url;
      const snapshots = sameUrl ? { ...current.snapshots } : {};
      if (object(reply.snapshots)) {
        for (const project of projects) {
          if (projectRevisions.get(project) !== perProject.get(project)) continue;
          const snapshot = snapshotOf(reply.snapshots[project], url, status, status.state !== 'online');
          if (snapshot) snapshots[project] = snapshot;
        }
      }
      const selected = sameUrl && current.projects.length ? current.projects : projects;
      publish({ ...current, url, projects: selected,
        catalog: sameUrl ? current.catalog : {state:"unknown",projects:[]},
        status, snapshots: Object.fromEntries(Object.entries(snapshots).filter(([project]) => selected.includes(project))) });
      persist();
      if (restore && selected.length && JSON.stringify(selected) !== JSON.stringify(projects)) {
        await invoke('team_service_subscribe', { projects: selected });
        if (generation === identityGeneration) pullAgain = true;
      }
    } catch { /* A later event or explicit subscription can recover; keep cached data. */ }
  })();
  pulling = task;
  try { await task; } finally {
    if (pulling === task) {
      pulling = undefined;
      if (pullAgain && generation === identityGeneration) { pullAgain = false; void pull(); }
    }
  }
}
async function configurationRestored(value: unknown) {
  if (!object(value)) return;
  let url: string, projects: string[];
  try { url = normalizeServiceUrl(String(value.url)); projects = projectsOf(value.projects); }
  catch { return; }
  const generation = ++identityGeneration;
  catalogRevision++; capabilityRevision++; configuring = false;
  pulling = undefined; pullAgain = false; projectRevisions.clear();
  publish({url, projects, snapshots:{}, catalog:{state:"unknown",projects:[]},
    status:{state:"connecting",token_configured:current.status.token_configured}});
  persist();
  await pull(false, true);
  if (generation !== identityGeneration) return;
  await refreshProjectCatalog();
  if (generation === identityGeneration) await loadCapabilities();
}
async function start() {
  if (starting) return starting;
  const epoch = lifetime;
  const task = (async () => {
    const installed: UnlistenFn[] = [];
    try {
      for (const name of ['team://snapshot', 'team://delta', 'team://live', 'team://status', 'team://configuration']) {
        installed.push(await listen(name, e => {
          if (epoch !== lifetime) return;
          if (name === 'team://configuration') void configurationRestored(e.payload);
          else eventReceived(e.payload);
        }));
      }
      if (epoch !== lifetime) { installed.forEach(stop => stop()); return; }
      unlisten = installed;
      await pull(false, true);
      if (epoch === lifetime) await refreshProjectCatalog();
      if (epoch === lifetime) await loadCapabilities();
    } catch {
      installed.forEach(stop => stop());
      if (epoch === lifetime) applyStatus({ ...current.status, state: 'error' });
    }
  })();
  starting = task;
  return task;
}
function subscribe(observer: () => void) {
  observers.add(observer);
  void start();
  return () => {
    observers.delete(observer);
    if (!observers.size) {
      lifetime++; identityGeneration++;
      unlisten.forEach(stop => stop()); unlisten = []; starting = undefined; pulling = undefined; pullAgain = false;
    }
  };
}
export function useTeamService(): TeamServiceState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
export async function configureTeamService(url: string, token: string, projects: string[]): Promise<void> {
  const normalized = normalizeServiceUrl(url), selection = projectsOf(projects);
  await start();
  const generation = ++identityGeneration;
  const visible = await checkedProjects(selection, {url: normalized, token});
  if (generation !== identityGeneration) throw new ProjectValidationError("团队服务已切换，请重新保存。");
  configuring = true;
  try {
    const result = await invoke<unknown>('team_service_configure', { url: normalized, token });
    if (generation !== identityGeneration) return;
    publish({ url: normalized, projects: selection, catalog: {state:"ready",projects:visible}, status: statusOf(result) ?? { state: 'offline', token_configured: true }, snapshots: {} });
    projectRevisions.clear();
    await invoke('team_service_subscribe', { projects: selection });
    if (generation !== identityGeneration) return;
    persist();
  } catch { throw Error('团队服务配置失败，请检查地址和令牌'); }
  finally { if (generation === identityGeneration) configuring = false; }
  pulling = undefined;
  await pull();
  await loadCapabilities();
}
export async function subscribeTeamService(projects: string[]): Promise<void> {
  const selection = projectsOf(projects);
  await start();
  const generation = ++identityGeneration;
  const visible = await checkedProjects(selection);
  if (generation !== identityGeneration) throw new ProjectValidationError("团队服务已切换，请重新更新订阅。");
  configuring = true;
  try {
    await invoke('team_service_subscribe', { projects: selection });
    if (generation !== identityGeneration) return;
    publish({ ...current, projects: selection, catalog:{state:"ready",projects:visible}, snapshots: Object.fromEntries(Object.entries(current.snapshots).filter(([p]) => selection.includes(p))) });
    persist();
  } catch { throw Error('团队项目订阅失败'); }
  finally { if (generation === identityGeneration) configuring = false; }
  pulling = undefined;
  await pull();
}

/** Refresh conflicts from REST through Rust; write responses never mutate this store. */
export async function refreshTeamService(project: string): Promise<TeamServiceProject | undefined> {
  const generation = identityGeneration;
  await refreshProjectCatalog();
  if (generation !== identityGeneration) throw new Error("团队服务已切换");
  await invoke("team_service_refresh", {project});
  if (generation !== identityGeneration) throw new Error("团队服务已切换");
  if (pulling) await pulling;
  await pull();
  if (generation !== identityGeneration) throw new Error("团队服务已切换");
  return current.snapshots[project];
}

async function loadCapabilities(): Promise<void> {
  if (!current.url) return;
  const generation = identityGeneration, epoch = lifetime, url = current.url, capability = ++capabilityRevision;
  try {
    const reply = await invoke<{ai_enabled: boolean | null}>("team_service_capabilities");
    if (generation !== identityGeneration || epoch !== lifetime || url !== current.url || capability !== capabilityRevision) return;
    publish({...current, status: {...current.status, ai_enabled: typeof reply?.ai_enabled === "boolean" ? reply.ai_enabled : null}});
  } catch { /* Unknown capabilities must not be presented as disabled. */ }
}
export interface AiRefreshResult { status: number; code: string; retry_after?: number }
export async function refreshServiceAi(project: string, key: string): Promise<AiRefreshResult> {
  const generation = identityGeneration;
  const reply = await invoke<AiRefreshResult>("team_service_ai_refresh", {project, key});
  if (generation !== identityGeneration) throw Error("团队服务已切换");
  if (reply.status === 503 && reply.code === "ai_disabled") {
    capabilityRevision++;
    publish({...current, status: {...current.status, ai_enabled: false}});
  }
  return {status: reply.status, code: reply.code, retry_after: reply.retry_after};
}

/** Only these controlled messages may be displayed by settings. */
export class ProjectValidationError extends Error {}
function projectFailure(error: unknown): ProjectValidationError {
  const status = object(error) ? error.status : 0;
  return new ProjectValidationError(status === 401 || status === 403
    ? "无权读取团队服务项目，请检查令牌权限。"
    : "无法读取团队服务项目，请检查连接后重试。");
}
export async function visibleProjects(candidate?: {url: string; token: string}): Promise<string[]> {
  try {
    const reply = await invoke<unknown>("team_service_projects", candidate);
    if (!object(reply) || !Array.isArray(reply.projects) || reply.projects.some(p => typeof p !== "string" || !projectPattern.test(p))) throw Error();
    return [...new Set(reply.projects as string[])];
  } catch (error) { throw projectFailure(error); }
}
async function checkedProjects(selection: string[], candidate?: {url: string; token: string}): Promise<string[]> {
  const visible = await visibleProjects(candidate);
  const missing = selection.filter(project => !visible.includes(project));
  if (missing.length) throw new ProjectValidationError(`团队服务中没有项目 ${missing.join("、")}，或当前令牌无权访问。`);
  return visible;
}
export async function refreshProjectCatalog(): Promise<void> {
  if (!current.url) return;
  const generation = identityGeneration, epoch = lifetime, request = ++catalogRevision;
  try {
    const projects = await visibleProjects();
    if (generation !== identityGeneration || epoch !== lifetime || request !== catalogRevision) return;
    publish({...current, catalog:{state:"ready",projects}});
  } catch (error) {
    if (generation !== identityGeneration || epoch !== lifetime || request !== catalogRevision) return;
    publish({...current, catalog:{state:"error",projects:[],message:(error as ProjectValidationError).message}});
  }
}
