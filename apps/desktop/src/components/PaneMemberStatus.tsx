import { useAgentSessions } from "../lib/agentSessions";
import type { CollaborationProfile } from "../lib/collaboration";
import { memberDisplay } from "../lib/memberDisplay";
import type { BoardSource } from "../lib/taskLookup";
import { isTeamLead } from "../lib/teamLead";
import { memberKey } from "../lib/teamMembers";
import { teamMemberStatus } from "../lib/teamPanelStatus";
import { useTeamService } from "../lib/teamService";
import { memberTaskTarget } from "../lib/teamServicePresentation";
import { sessionTeamMember } from "../lib/tmuxGroups";
import type { SessionInfo } from "../types";
import "./Collaboration.css";
import "./PaneMemberStatus.css";

/**
 * Status bar centre: who the active pane is (status dot · member · card). Identity, status and the
 * card come from the same sources as the team panel; non-member panes render nothing.
 */
export default function PaneMemberStatus({ pane, profile, board, onOpenTask, onOpenMember }: {
  pane: SessionInfo;
  /** Collaboration binding of this pane: the team panel counts its own session as the Lead. */
  profile?: CollaborationProfile;
  board?: BoardSource;
  onOpenTask: (target: { project: string; code: string }) => void;
  onOpenMember: (target: { project: string; key: string }) => void;
}) {
  const service = useTeamService();
  const match = sessionTeamMember(pane, service);
  // Same collector feed as the team list, polled only while a member pane is shown.
  const live = useAgentSessions(match ? board : undefined, match ? [match.member] : []);
  if (!match) return null;
  const { project, member } = match;
  const self = profile?.project === project
    ? { tmuxId: profile.tmuxId, tmuxCreated: profile.tmuxCreated, workdir: profile.workdir, username: pane.server.username }
    : undefined;
  const status = teamMemberStatus(member, { serviceLive: service.snapshots[project]?.live, live, lead: isTeamLead(member, self) });
  const name = memberDisplay(member).title;
  const task = memberTaskTarget(member);
  const card = task ? `${task.project}/${task.code}` : "";
  return <div className="pane-member" role="group" aria-label={`当前窗格 · ${name}`}>
    <span className={`team-live-dot is-${status.tone}`} role="img" aria-label={status.label} title={status.title ?? status.label}/>
    <button type="button" className="pane-member-name" title={`在团队面板中查看 ${name}`}
      onClick={() => onOpenMember({ project, key: memberKey(member) })}>{name}</button>
    {task && <button type="button" className="pane-member-card" disabled={!board} title={board ? `打开卡片 ${card}` : "请在「设置 → 团队」填写看板地址"}
      onClick={() => onOpenTask(task)}>{card}</button>}
  </div>;
}
