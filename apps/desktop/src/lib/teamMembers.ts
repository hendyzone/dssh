import type { ServerEntry, SessionInfo, TabInfo } from "../types";
import { resolveWorktree } from "./collaboration";
import { findTmuxTab } from "./tmuxTabs";

export interface TeamMember {
  id?: string;
  project: string;
  email: string;
  role: string;
  host: string;
  port: number;
  username: string;
  workdir: string;
  tmux: NonNullable<SessionInfo["tmux"]>;
  updatedAt?: string;
  responsibilities?: string;
  quota?: string;
  currentTask?: string;
  notes?: string;
}
export const memberNoteFields = {responsibilities:"主要负责", quota:"额度情况", currentTask:"当前在做", notes:"其他备注"} as const;
export type MemberNoteField = keyof typeof memberNoteFields;

/** Pick only portable location fields, never connection credentials or local IDs. */
export function parseMember(value: unknown, project: string): TeamMember {
  const m = value as TeamMember;
  const validText = (v: unknown, max = 1024): v is string => typeof v === "string" && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
  const validEmail = m && typeof m.email === "string" && (m.email === "" || (validText(m.email, 254) && /^[^\s@]+@[^\s@]+$/.test(m.email)));
  const validId = m && typeof m.id === "string" && /^member-[a-zA-Z0-9-]{1,80}$/.test(m.id);
  if (!m || m.project !== project || !validEmail || (!m.email && !validId) ||
      !validText(m.role, 80) || !validText(m.host, 255) || /[\s/]/.test(m.host) || !validText(m.username, 80) ||
      !Number.isInteger(m.port) || m.port < 1 || m.port > 65535 || !validText(m.workdir) || !m.workdir.startsWith("/") ||
      !m.tmux || !/^\$\d+$/.test(m.tmux.id) || !Number.isSafeInteger(m.tmux.created) || m.tmux.created <= 0 || !validText(m.tmux.name, 255)) {
    throw new Error("成员位置无效：请核对项目、邮箱、服务器、worktree 和 tmux 身份。");
  }
  const info: Partial<Record<MemberNoteField,string>> = {};
  for (const key of Object.keys(memberNoteFields) as MemberNoteField[]) {
    const value = m[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 2000 || /[\x00-\x08\x0b-\x1f\x7f]/.test(value)) throw new Error("成员备注须为不超过 2000 字的文本");
    info[key] = value;
  }
  return { ...info, ...(validId ? {id:m.id} : {}), project, email:m.email, role:m.role, host:m.host, port:m.port, username:m.username, workdir:m.workdir,
    tmux:{id:m.tmux.id, created:m.tmux.created, name:m.tmux.name},
    ...(validText(m.updatedAt, 80) ? {updatedAt:m.updatedAt} : {}) };
}

export function matchingServers(member: TeamMember, servers: ServerEntry[]) {
  return servers.filter(s => s.host.trim().toLowerCase() === member.host.trim().toLowerCase() && s.port === member.port && s.username === member.username);
}

export async function connectedMemberTab(member: TeamMember, server: ServerEntry, tabs: TabInfo[], backendIds: Record<string, string | null>, preferredTabId?: string | null) {
  // Search live panes first; a disconnected duplicate must not hide a live match.
  const liveTabs = tabs.map(tab => ({...tab, panes:tab.panes.map(pane => backendIds[pane.id] ? pane : {...pane, tmux:undefined})}));
  const existing = findTmuxTab(liveTabs, server, member.tmux, preferredTabId);
  if (!existing) return null;
  const backend = backendIds[existing.tab.panes[existing.paneIndex].id]!;
  const root = await resolveWorktree(backend, member.tmux);
  if (root !== member.workdir) throw new Error("成员工作区已变化，请更新成员位置。");
  return existing;
}

export const TEAM_MAPPING_KEY = "dssh.team-connections.v1";
export const memberKey = (m: TeamMember) => m.email || m.id!;
export const memberMappingKey = (m: TeamMember) => JSON.stringify([m.project, memberKey(m), m.host, m.port, m.username]);
export function loadTeamMappings(): Record<string, string> {
  try {
    const value = JSON.parse(localStorage.getItem(TEAM_MAPPING_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch { return {}; }
}
