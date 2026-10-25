import { liveStatus, type AgentSession, type LiveStatus } from "./agentSessions";
import type { TeamAvatarStatus } from "./teamAvatar";
import type { TeamLive } from "./teamService";
import type { TeamMember } from "./teamMembers";

/** Only no_agent delegates status to the existing collector. Missing service data stays unknown. */
export function serviceMemberState(member: TeamMember, report: TeamLive | undefined, fallback?: AgentSession): AgentSession | undefined {
  if (report?.match === "no_agent") return fallback;
  const gone = report?.match === "gone";
  return {
    host: member.host, session: member.tmux.name, box: member.email, tool: "", project: member.project,
    state: gone ? "gone" : report?.state ?? "unknown", stateDetail: report?.detail ?? "",
    stateSince: report?.since ? Date.parse(report.since) / 1000 || 0 : 0,
    hostOk: true, hostError: "", stale: report?.stale === true, seenAt: report?.at ? Date.parse(report.at) / 1000 || 0 : 0,
    taskCode: "", taskStatus: "", worktree: member.workdir, branch: "", commitHash: "", commitTime: 0,
    commitSubject: "", dirty: 0, model: report?.model ?? "", lastLine: report?.last_line ?? "",
    ...(typeof report?.ctx_pct === "number" ? {contextPct: report.ctx_pct} : {}),
  };
}
export function serviceMemberStatus(member: TeamMember, report: TeamLive | undefined, fallback: AgentSession | undefined, now: number, lead: boolean): {session?: AgentSession; status: LiveStatus} {
  const session = serviceMemberState(member, report, fallback);
  return {session, status: liveStatus(session, now, 180, lead)};
}
export function serviceMemberAvatar(member: TeamMember, report: TeamLive | undefined, fallback?: AgentSession): TeamAvatarStatus {
  const session = serviceMemberState(member, report, fallback);
  const state = !session || session.stale || !session.hostOk ? "unknown" : session.state;
  const avatar: TeamAvatarStatus["state"] = state === "running" ? "working" : state === "idle" ? "idle"
    : state === "stuck" ? "error" : state === "waiting_input" || state === "input_pending" ? "blocked" : "unknown";
  const labels = {working:"工作中",idle:"空闲",error:"卡住",blocked:"等待处理",unknown:"待确认",done:"已完成"};
  return {state:avatar,source:"program",label:`${labels[avatar]}（${report?.match === "no_agent" ? "看板状态" : "团队服务"}）`};
}
