import { collaborationKey, type CollaborationProfile, type CollaborationSession } from "./collaboration";
import { briefKey, matchSession, type SessionsSnapshot, type TaskBrief } from "./agentSessions";
import { resolveTeamAvatar, type TeamAvatarStatus } from "./teamAvatar";
import { matchingServers, memberKey, type TeamMember } from "./teamMembers";
import { sameSshEndpoint } from "./tmuxTabs";
import type { TmuxProgramSnapshot } from "./tmuxProgramStatus";
import type { ServerEntry } from "../types";

export interface OfficeMember {
  id: string; name: string; isLead: boolean; status: TeamAvatarStatus;
  taskText: string; taskSource: "board" | "manual" | "none"; paletteKey: string;
}
export interface OfficeSource {
  id: string; label: string; availability: "ready" | "offline" | "error" | "loading";
  notice: string; members: OfficeMember[];
}
export interface OfficeProject { id: string; name: string; sources: OfficeSource[] }
/** Presentation-only allowlist: never send server records, profiles, handles or mail bodies. */
export interface OfficeSnapshot {
  version: 1; themeId: string; animationEnabled: boolean;
  mailAvailability: "unavailable"; projects: OfficeProject[];
}
/** Internal main-window transport; deliberately separate from OfficeSnapshot. */
export interface OfficeTeamSource {
  id: string; project: string; label: string; profile: CollaborationProfile;
  server?: ServerEntry; backendId?: string;
}
export interface OfficeRoster {
  availability: OfficeSource["availability"]; notice: string; members: TeamMember[];
}
export interface OfficeBoard {
  snapshot?: SessionsSnapshot; briefs: Record<string, TaskBrief>; offline: boolean;
}
export interface OfficeBuildContext {
  servers: ServerEntry[]; sessions: CollaborationSession[];
  programSnapshots?: Record<string, TmuxProgramSnapshot>; mapping?: Record<string, string>;
  boards?: Record<string, OfficeBoard>; themeId: string; animationEnabled: boolean;
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
    const source: OfficeTeamSource = { id, project: profile.project, label: server ? `${server.name} · ${profile.tmuxName || profile.tmuxId}` : profile.tmuxName || "未连接的团队", profile, server, backendId: live?.backendId };
    // Prefer a reachable duplicate binding, never merge distinct worktrees by project name.
    const rank = attached ? 2 : live ? 1 : 0;
    if (!result.has(id) || rank > routeRanks.get(id)!) { result.set(id, source); routeRanks.set(id, rank); }
  }
  return [...result.values()];
}
const shortText = (value: string) => value.trim().split(/\r?\n/)[0].slice(0, 100);
function taskText(member: TeamMember, board?: OfficeBoard): Pick<OfficeMember, "taskText" | "taskSource"> {
  const session = board && !board.offline && board.snapshot ? matchSession(member, board.snapshot.sessions) : undefined;
  if (session && !session.stale && session.hostOk) {
    if (!session.taskCode) return { taskText: "暂无当前任务", taskSource: "board" };
    const brief = board!.briefs[briefKey(session.project, session.taskCode)];
    return { taskText: shortText([session.taskCode, brief?.brief || brief?.title].filter(Boolean).join(" · ")), taskSource: "board" };
  }
  const manual = shortText(member.currentTask ?? "");
  return manual ? { taskText: manual, taskSource: "manual" } : { taskText: "暂无当前任务", taskSource: "none" };
}

export function buildOfficeSnapshot(sources: OfficeTeamSource[], rosters: Record<string, OfficeRoster>, context: OfficeBuildContext): OfficeSnapshot {
  const projects = new Map<string, OfficeProject>();
  for (const source of sources) {
    let project = projects.get(source.project);
    if (!project) { project = { id: officeKey(source.project), name: source.project, sources: [] }; projects.set(source.project, project); }
    const roster = rosters[source.id] ?? { availability: source.backendId ? "loading" : "offline", notice: source.backendId ? "正在读取团队…" : "连接 Lead 所在服务器后可读取团队", members: [] };
    const members = roster.availability === "ready" ? roster.members.map(member => {
      const boundLead = !!source.server && matchingServers(member, [source.server]).length > 0 && member.tmux.id === source.profile.tmuxId && member.tmux.created === source.profile.tmuxCreated && member.workdir === source.profile.workdir;
      return {
        id: officeKey(JSON.stringify([source.id, memberKey(member)])), name: member.role,
        isLead: /^lead\b/i.test(member.role.trim()) || boundLead,
        status: resolveTeamAvatar(member, context), ...taskText(member, context.boards?.[source.id]),
        paletteKey: officeKey(memberKey(member)),
      };
    }).sort((a, b) => Number(b.isLead) - Number(a.isLead)) : [];
    project.sources.push({ id: source.id, label: source.label, availability: roster.availability, notice: roster.notice, members });
  }
  return { version: 1, themeId: context.themeId, animationEnabled: context.animationEnabled, mailAvailability: "unavailable", projects: [...projects.values()] };
}
