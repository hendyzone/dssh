/** One naming rule for every place that shows a team member (room, member list, details). */
import type { TeamMember } from "./teamMembers";

export interface MemberLiveInfo { child?: string; model?: string | null; machine?: string | null; host?: string }
export interface MachineInfo { online?: boolean; version?: string; host?: string }
export type MachinesMap = Record<string, MachineInfo>;

const TOOLS = ["claude", "codex", "pi", "dsh", "cursor", "agy"] as const;
const TOOL_PATTERNS: [RegExp, string][] = [
  [/(^|[^a-z])claude([^a-z]|$)/i, "claude"],
  [/(^|[^a-z])codex([^a-z]|$)/i, "codex"],
  [/(^|[^a-z])dsh([^a-z]|$)/i, "dsh"],
  [/(^|[^a-z])cursor([^a-z]|$)/i, "cursor"],
  [/(^|[^a-z])agy([^a-z]|$)/i, "agy"],
  [/(^|[^a-z])pi([^a-z]|$)/i, "pi"],
];
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Title: the mailbox (email local part); no email falls back to the stable member id. */
export function memberBox(member: Pick<TeamMember, "email" | "id"> & Partial<Pick<TeamMember, "tmux">>): string {
  const local = (member.email ?? "").split("@")[0].trim();
  return local || member.id || member.tmux?.name || "member";
}

/** Tool from the live child, the box name, or the role text; unknown tools stay hidden. */
export function memberTool(member: TeamMember, live?: MemberLiveInfo): string | undefined {
  for (const source of [live?.child, memberBox(member)]) {
    if (!source) continue;
    const text = String(source).toLowerCase();
    for (const [pattern, tool] of TOOL_PATTERNS) if (pattern.test(text)) return tool;
    const last = text.split(/[-_]/).filter(Boolean).at(-1) ?? "";
    if ((TOOLS as readonly string[]).includes(last)) return last;
  }
  for (const tool of TOOLS) if (TOOL_PATTERNS.find(([pattern]) => pattern.source.includes(tool))?.[0].test(member.role ?? "")) return tool;
  return undefined;
}

/** Model from live.model, else the last comma-separated part of a role parenthetical. */
export function memberModel(member: TeamMember, live?: MemberLiveInfo): string | undefined {
  const fromLive = (live?.model ?? "").trim();
  if (fromLive) return fromLive;
  const parenthetical = (member.role ?? "").match(/[（(]([^）)]*)[）)]/);
  if (!parenthetical) return undefined;
  const parts = parenthetical[1].split(/[，,、]/).map(part => part.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : undefined;
}

/** Machine name only. Raw IP addresses are never displayed. */
export function memberMachine(member: TeamMember, live?: MemberLiveInfo, machines: MachinesMap = {}): string | undefined {
  const fromLive = (live?.machine ?? "").trim();
  if (fromLive) return fromLive;
  const host = (member.host ?? "").trim();
  if (host && machines[host]) return host;
  const named = Object.keys(machines).find(name => name.toLowerCase() === host.toLowerCase());
  if (named) return named;
  if (host && !IPV4.test(host) && !host.includes(":") && host.length <= 64) return host;
  return undefined;
}

export interface MemberDisplay {
  title: string;
  subtitle: string;
  machine?: string;
  role: string;
  responsibilities?: string;
}

export function memberDisplay(member: TeamMember, live?: MemberLiveInfo, machines: MachinesMap = {}): MemberDisplay {
  const tool = memberTool(member, live);
  const model = memberModel(member, live);
  const machine = memberMachine(member, live, machines);
  return {
    title: memberBox(member),
    subtitle: [tool, model].filter(Boolean).join(" · "),
    ...(machine ? { machine } : {}),
    role: member.role ?? "",
    ...(member.responsibilities ? { responsibilities: member.responsibilities } : {}),
  };
}
