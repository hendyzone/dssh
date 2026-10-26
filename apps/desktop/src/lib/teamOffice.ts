import {serviceAi, type ServiceAi} from "./serviceAi";
import type { TeamLive } from "./teamService";
import { serviceMemberAvatar } from "./teamServicePresentation";
import { memberDisplay } from "./memberDisplay";
import { collaborationKey, type CollaborationProfile, type CollaborationSession } from "./collaboration";
import { briefKey, matchSession, type SessionsSnapshot, type TaskBrief } from "./agentSessions";
import { resolveTeamAvatar, type TeamAvatarStatus } from "./teamAvatar";
import { matchingServers, memberKey, type TeamMember } from "./teamMembers";
import { sameSshEndpoint } from "./tmuxTabs";
import type { TmuxProgramSnapshot } from "./tmuxProgramStatus";
import type { ServerEntry } from "../types";

export type OfficeMailEndpoint = {kind:"station";sourceId:string;memberId:string} | {kind:"edge"};
export interface OfficeMailEvent { id:string; uid:number; kind:string|null; from:OfficeMailEndpoint; to:OfficeMailEndpoint; }
export interface OfficeMailView {
  sequence:number; reset:number; expiresAt:number; events:OfficeMailEvent[]; overflow:number;
  availability:"ready"|"loading"|"error"|"unavailable";
}
/** Main-memory only; addresses are never included in OfficeSnapshot. */
export type OfficeMailDirectory = Map<string, OfficeMailEndpoint[]>;
/** Exact mailbox-source binding, separate from the room's worktree grouping. */
export function officeMailBindingKey(server: ServerEntry | undefined, profile: CollaborationProfile, fallback = ""): string {
  return officeKey(JSON.stringify(server
    ? [server.kind, server.host.trim().toLowerCase(), server.port, server.username, profile.workdir, profile.tmuxId, profile.tmuxCreated]
    : [fallback]));
}
export function officeMailAddress(address:string):string {
  const value=address.trim();const at=value.lastIndexOf("@");
  return at>0 ? value.slice(0,at)+"@"+value.slice(at+1).toLowerCase() : value;
}
export function buildOfficeMailDirectory(sources:OfficeTeamSource[],rosters:Record<string,OfficeRoster>):OfficeMailDirectory {
  const directory: OfficeMailDirectory = new Map();
  for (const source of sources) {
    const members = rosters[source.id]?.availability === "ready" ? rosters[source.id].members : [];
    const endpoint = (member: TeamMember): OfficeMailEndpoint => ({
      kind: "station", sourceId: source.id,
      memberId: officeKey(JSON.stringify([source.id, memberKey(member)])),
    });
    for (const member of members) {
      if (!member.email) continue;
      const address = officeMailAddress(member.email);
      const matches = directory.get(address) ?? [];
      matches.push(endpoint(member));
      directory.set(address, matches);
    }
  }
  return directory;
}

export type OfficeServiceState = "connecting" | "online" | "offline" | "unauthorized" | "error";
export interface OfficeService { state: OfficeServiceState; at?: number; tokenConfigured?: boolean }
export interface OfficeMember {
  id: string; name: string; isLead: boolean; status: TeamAvatarStatus;
  ai?: ServiceAi; aiEnabled?: boolean | null;
  taskText: string; taskSource: "board" | "manual" | "none"; paletteKey: string;
  /** Extra presentation data for the station card; all bounded strings, no credentials. */
  taskFull?: string; responsibilities?: string; updatedAt?: string; role?: string; model?: string;
  tool?: string; machine?: string; machineOnline?: boolean; machineVersion?: string;
  liveState?: string; match?: "exact" | "replaced" | "gone" | "no_agent";
  detail?: string; since?: number;
}
export interface OfficeSource {
  id: string; label: string; availability: "ready" | "offline" | "error" | "loading";
  notice: string; members: OfficeMember[];
}
export interface OfficeProject { id: string; name: string; sources: OfficeSource[] }
/** Presentation-only allowlist: never send server records, profiles, handles or mail bodies. */
export interface OfficeSnapshot {
  version: 1; themeId: string; animationEnabled: boolean;
  mailAvailability: "unavailable"; projects: OfficeProject[]; mail?:OfficeMailView;
  /** Team-service connection shown at the top of the room (no addresses/tokens). */
  service?: OfficeService;
}
/** Internal main-window transport; deliberately separate from OfficeSnapshot. */
export interface OfficeTeamSource {
  id: string; project: string; label: string; profile: CollaborationProfile;
  server?: ServerEntry; backendId?: string; service?: boolean;
}
export interface OfficeRoster {
  availability: OfficeSource["availability"]; notice: string; members: TeamMember[]; live?: Record<string,TeamLive>; ai?: Record<string,unknown>; aiEnabled?: boolean | null;
  machines?: Record<string, unknown>;
}
export interface OfficeBoard {
  snapshot?: SessionsSnapshot; briefs: Record<string, TaskBrief>; offline: boolean;
}
export interface OfficeBuildContext {
  servers: ServerEntry[]; sessions: CollaborationSession[];
  programSnapshots?: Record<string, TmuxProgramSnapshot>; mapping?: Record<string, string>;
  boards?: Record<string, OfficeBoard>; themeId: string; animationEnabled: boolean;
  service?: OfficeService;
}
/** Stable opaque display keys. The original route stays exclusively in main memory. */
export function officeKey(value: string): string {
  let a = 2166136261, b = 5381;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    a = Math.imul(a ^ code, 16777619) >>> 0;
    b = (Math.imul(b, 33) ^ code) >>> 0;
  }
  return `${a.toString(36)}-${b.toString(36)}-${value.length}`;
}

/** Enumerate registered bindings only; a saved server without a live route stays visible offline. */
export function officeTeamSources(profiles: Record<string, CollaborationProfile>, servers: ServerEntry[], sessions: CollaborationSession[]): OfficeTeamSource[] {
  const result = new Map<string, OfficeTeamSource>();
  const routeRanks = new Map<string, number>();
  for (const [key, profile] of Object.entries(profiles)) {
    if (!profile.enabled || !profile.membersEnabled) continue;
    const server = [...servers, ...sessions.map(session => session.pane.server)].find(candidate => collaborationKey(candidate.id, profile) === key);
    const routes = server ? sessions.filter(session => session.backendId && sameSshEndpoint(server, session.pane.server)) : [];
    const attached = routes.find(session => session.pane.tmux?.id === profile.tmuxId && session.pane.tmux.created === profile.tmuxCreated);
    const live = attached ?? routes[0];
    const identity = JSON.stringify(server ? [server.kind ?? "ssh", server.host.trim().toLowerCase(), server.port, server.username, profile.workdir, profile.project] : [key, profile.project]);
    const id = officeKey(identity);
    const source: OfficeTeamSource = { id, project: profile.project, label: server ? `${server.name} · ${profile.tmuxName || profile.tmuxId} · ${profile.workdir.split("/").filter(Boolean).at(-1) || "/"}` : profile.tmuxName || "未连接的团队", profile, server, backendId: live?.backendId };
    // Prefer a reachable duplicate binding, never merge distinct worktrees by project name.
    const rank = attached ? 2 : live ? 1 : 0;
    if (!result.has(id) || rank > routeRanks.get(id)!) { result.set(id, source); routeRanks.set(id, rank); }
  }
  return [...result.values()];
}
const shortText = (value: string) => value.trim().split(/\r?\n/)[0].slice(0, 100);
function taskText(member: TeamMember, board?: OfficeBoard): Pick<OfficeMember, "taskText" | "taskSource" | "taskFull"> {
  const session = board && !board.offline && board.snapshot ? matchSession(member, board.snapshot.sessions) : undefined;
  if (session && !session.stale && session.hostOk) {
    if (!session.taskCode) return { taskText: "暂无当前任务", taskSource: "board", taskFull: "" };
    const brief = board!.briefs[briefKey(session.project, session.taskCode)];
    const full = [session.taskCode, brief?.brief || brief?.title].filter(Boolean).join(" · ");
    return { taskText: shortText(full), taskSource: "board", taskFull: full };
  }
  const manual = (member.currentTask ?? "").trim();
  return manual
    ? { taskText: shortText(manual), taskSource: "manual", taskFull: manual }
    : { taskText: "暂无当前任务", taskSource: "none", taskFull: "" };
}

const TOOL_HINTS: [RegExp, string][] = [
  [/\bclaude\b/i, "claude"], [/\bcodex\b/i, "codex"], [/\bpi\b/i, "pi"],
  [/\bdsh\b|deepseek/i, "dsh"], [/\bcursor\b/i, "cursor"], [/\bagy\b|antigravity/i, "agy"],
];
/** Infer the tool from display metadata only; unknown tools stay hidden rather than guessed. */
export function officeTool(member: TeamMember, live?: TeamLive): string | undefined {
  const haystack = [live?.model, live?.session, member.email, member.role].filter(Boolean).join(" ");
  for (const [pattern, tool] of TOOL_HINTS) if (pattern.test(haystack)) return tool;
  return undefined;
}

/** Counts under a team sign; unknown/offline/gone members count as offline. */
export function officeStatusCounts(members: OfficeMember[]) {
  const counts = { running: 0, waiting: 0, stuck: 0, idle: 0, offline: 0 };
  for (const member of members) {
    const state = member.liveState ?? member.status.state;
    const offline = member.match === "gone" || member.match === "replaced" || member.match === "no_agent"
      || member.machineOnline === false || member.status.state === "unknown"
      || state === "unknown" || state === "offline";
    if (offline) counts.offline++;
    else if (state === "running" || state === "working") counts.running++;
    else if (state === "waiting_input" || state === "input_pending" || state === "blocked") counts.waiting++;
    else if (state === "stuck" || state === "error") counts.stuck++;
    else if (state === "idle") counts.idle++;
    else counts.offline++;
  }
  return counts;
}

export function buildOfficeSnapshot(sources: OfficeTeamSource[], rosters: Record<string, OfficeRoster>, context: OfficeBuildContext): OfficeSnapshot {
  const projects = new Map<string, OfficeProject>();
  for (const source of sources) {
    const identity = source.service ? source.id : source.project;
    let project = projects.get(identity);
    if (!project) { project = { id: officeKey(identity), name: source.project, sources: [] }; projects.set(identity, project); }
    const roster = rosters[source.id] ?? { availability: source.backendId ? "loading" : "offline", notice: source.backendId ? "正在读取团队…" : "连接 Lead 所在服务器后可读取团队", members: [] };
    const members = (roster.availability === "ready" || source.service) ? roster.members.map(member => {
      const boundLead = !!source.server && matchingServers(member, [source.server]).length > 0 && member.tmux.id === source.profile.tmuxId && member.tmux.created === source.profile.tmuxCreated && member.workdir === source.profile.workdir;
      const live = roster.live?.[memberKey(member)];
      const machines = (roster.machines ?? {}) as Record<string, { online?: boolean; version?: string }>;
      const display = memberDisplay(member, live, machines);
      const machineName = display.machine;
      const machineRecord = machineName ? machines[machineName] : undefined;
      return {
        id: officeKey(JSON.stringify([source.id, memberKey(member)])), name: display.title,
        isLead: /^lead\b/i.test(member.role.trim()) || boundLead,
        status: source.service ? serviceMemberAvatar(member, live, context.boards?.[source.id]?.offline ? undefined : matchSession(member, context.boards?.[source.id]?.snapshot?.sessions??[])) : resolveTeamAvatar(member, context), ...taskText(member, context.boards?.[source.id]),
        paletteKey: officeKey(memberKey(member)),
        ai: serviceAi(roster.ai?.[memberKey(member)]), aiEnabled: roster.aiEnabled,
        responsibilities: member.responsibilities?.slice(0, 500),
        updatedAt: member.updatedAt,
        role: member.role?.slice(0, 80),
        model: display.subtitle.split(" · ").slice(1).join(" · ") || undefined,
        tool: officeTool(member, live),
        machine: machineName ? String(machineName).slice(0, 64) : undefined,
        machineOnline: typeof machineRecord?.online === "boolean" ? machineRecord.online : undefined,
        machineVersion: typeof machineRecord?.version === "string" ? machineRecord.version.slice(0, 40) : undefined,
        liveState: live?.state, match: live?.match, detail: live?.detail?.slice(0, 200),
        since: live?.since ? Date.parse(live.since) || undefined : undefined,
      };
    }).sort((a, b) => Number(b.isLead) - Number(a.isLead)) : [];
    project.sources.push({ id: source.id, label: source.label, availability: roster.availability, notice: roster.notice, members });
  }
  return { version: 1, themeId: context.themeId, animationEnabled: context.animationEnabled, mailAvailability: "unavailable", projects: [...projects.values()], ...(context.service ? { service: context.service } : {}) };
}
