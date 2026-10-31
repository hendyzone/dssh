import type { TeamMember } from "./teamMembers";

export type LeadPanelSelf = { tmuxId: string; tmuxCreated: number; workdir: string; username: string };

/** Lead: role 「Lead…」、tmux 名或邮箱本地部分以 -lead 结尾、或即团队面板绑定的 tmux 会话。 */
export function isTeamLead(
  m: Pick<TeamMember, "role" | "tmux" | "email" | "workdir" | "username">,
  self?: LeadPanelSelf,
): boolean {
  if (/^lead\b/i.test((m.role ?? "").trim())) return true;
  const tmuxName = (m.tmux?.name ?? "").trim();
  if (tmuxName && /-lead$/i.test(tmuxName)) return true;
  const local = (m.email ?? "").split("@")[0]?.trim() ?? "";
  if (local && /-lead$/i.test(local)) return true;
  return !!self
    && m.tmux.id === self.tmuxId
    && m.tmux.created === self.tmuxCreated
    && m.workdir === self.workdir
    && m.username === self.username;
}
