/** One naming rule for every place that shows a team member (room, member list, details). */
import type { TeamMember } from "./teamMembers";
import { isLeadMember } from "./agentSessions";

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

type BoxFields = Pick<TeamMember, "email" | "id" | "name" | "tmux">;
type LeadFields = Pick<TeamMember, "role" | "workdir" | "username">;

/** Mailbox box name: mailbox local → tmux session name → roster name → stable id. Tool inference reads this. */
function mailboxBox(member: BoxFields): string {
  const local = (member.email ?? "").split("@")[0].trim();
  if (local) return local;
  const tmux = (member.tmux?.name ?? "").trim();
  if (tmux) return tmux;
  const name = (member.name ?? "").trim();
  if (name) return name;
  return member.id || "member";
}

/**
 * Machine segment in a box name: a `-cw<digits>` part between dashes or at the end
 * (`nst-vision-cw2-lead` → `nst-vision-lead`, `dcollab-cw1-lead` → `dcollab-lead`).
 */
export const MACHINE_SEGMENT = /-cw\d+(?=-|$)/gi;
export const withoutMachine = (name: string): string => name.replace(MACHINE_SEGMENT, "") || name;

/**
 * Title. Workers: the mailbox box name. Leads move between machines, so their title never carries
 * the machine segment: tmux session name (`<project>-lead`) → mailbox local → roster name → id,
 * each without `-cwN`. Display only — mailbox, member key and connections are untouched.
 */
export function memberBox(member: BoxFields & Partial<LeadFields>, lead = isLeadMember({ role: "", workdir: "", username: "", ...member })): string {
  if (!lead) return mailboxBox(member);
  for (const source of [member.tmux?.name, (member.email ?? "").split("@")[0], member.name]) {
    const text = (source ?? "").trim();
    if (text) return withoutMachine(text);
  }
  return member.id || "member";
}

/** Tool from the live child, the box name, or the role text; unknown tools stay hidden. */
export function memberTool(member: TeamMember, live?: MemberLiveInfo): string | undefined {
  for (const source of [live?.child, mailboxBox(member)]) {
    if (!source) continue;
    const text = String(source).toLowerCase();
    for (const [pattern, tool] of TOOL_PATTERNS) if (pattern.test(text)) return tool;
    const last = text.split(/[-_]/).filter(Boolean).at(-1) ?? "";
    if ((TOOLS as readonly string[]).includes(last)) return last;
  }
  for (const tool of TOOLS) if (TOOL_PATTERNS.find(([pattern]) => pattern.source.includes(tool))?.[0].test(member.role ?? "")) return tool;
  return undefined;
}

/** Model from live.model, then a "tool · model" role, then the legacy role parenthetical. */
export function memberModel(member: TeamMember, live?: MemberLiveInfo): string | undefined {
  const fromLive = (live?.model ?? "").trim();
  if (fromLive) return fromLive;
  const role = member.role ?? "";
  // New role format: "dsh · deepseek-v4-flash" (tool first, model from the second part on).
  const segments = role.split(" · ").map(part => part.trim());
  if (segments.length >= 2) {
    const head = segments[0].toLowerCase();
    const known = (TOOLS as readonly string[]).includes(head) || head === memberTool(member, live);
    if (known) {
      const model = segments.slice(1).filter(Boolean).join(" · ");
      if (model) return model;
    }
  }
  const parenthetical = role.match(/[（(]([^）)]*)[）)]/);
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

/** `lead` lets a caller that knows more (the team panel's own Lead session) override the roster-only check. */
export function memberDisplay(member: TeamMember, live?: MemberLiveInfo, machines: MachinesMap = {}, lead?: boolean): MemberDisplay {
  const tool = memberTool(member, live);
  const model = memberModel(member, live);
  const machine = memberMachine(member, live, machines);
  const modelLabel = model && model.toLowerCase() !== (tool ?? "").toLowerCase() ? model : undefined;
  return {
    title: memberBox(member, lead ?? isLeadMember(member)),
    subtitle: [tool, modelLabel].filter(Boolean).join(" · "),
    ...(machine ? { machine } : {}),
    role: member.role ?? "",
    ...(member.responsibilities ? { responsibilities: member.responsibilities } : {}),
  };
}
