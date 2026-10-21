import type { CollaborationSession } from "./collaboration";
import type { ProgramStatusKind } from "./programStatus";
import { matchingServers, memberActivity, memberActivityLabels, memberMappingKey, type TeamMember } from "./teamMembers";
import type { TmuxProgramPane, TmuxProgramSnapshot } from "./tmuxProgramStatus";
import type { ServerEntry } from "../types";
import { sameSshEndpoint } from "./tmuxTabs";

export type TeamAvatarState = "working" | "idle" | "unknown" | "done" | "blocked" | "error";
export interface TeamAvatarStatus {
  state: TeamAvatarState;
  kind?: ProgramStatusKind;
  source: "program" | "activity";
  label: string;
}
export interface TeamAvatarContext {
  servers: ServerEntry[];
  sessions: CollaborationSession[];
  programSnapshots?: Record<string, TmuxProgramSnapshot>;
  mapping?: Record<string, string>;
}
const priority = { error: 0, blocked: 1, working: 2, done: 3, idle: 4 };
const programLabels = { working: "工作中", idle: "空闲", done: "已完成", blocked: "等待处理", error: "发生错误" };
const kindLabels = { permission: "等待授权", question: "等待回答", auth: "等待认证" };
const compareIds = (a: TmuxProgramPane, b: TmuxProgramPane) => a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0;

/** Resolve only an explicitly mapped or exact SSH endpoint and tmux incarnation.
 * A native snapshot with an error is stale even when its old panes are retained.
 * Unaddressed tmux-client output must never stand in for a member's pane status.
 */
export function resolveTeamAvatar(member: TeamMember, context: TeamAvatarContext): TeamAvatarStatus {
  const activity = memberActivity(member);
  const fallback: TeamAvatarStatus = { state: activity, source: "activity", label: `${memberActivityLabels[activity]}（成员活动）` };
  const mappedId = context.mapping?.[memberMappingKey(member)];
  const mapped = mappedId ? context.servers.find(server => server.id === mappedId)
    ?? context.sessions.find(session => session.pane.server.id === mappedId)?.pane.server : undefined;
  if (mappedId && (!mapped || mapped.kind === "local")) return fallback;
  const live = context.sessions.filter(session => session.backendId && session.pane.server.kind !== "local" && (mapped
    ? sameSshEndpoint(mapped, session.pane.server)
    : session.pane.server.kind !== "local" && matchingServers(member, [session.pane.server]).length > 0));
  if (!live.length) return fallback;
  const serverIds = [...new Set(live.map(session => session.pane.server.id))];
  let candidates: TmuxProgramPane[] | undefined;
  let signature: string | undefined;
  for (const serverId of serverIds) {
    const snapshot = context.programSnapshots?.[serverId];
    if (!snapshot?.supported || snapshot.error) return fallback;
    const panes = snapshot.panes.filter(pane => pane.sessionId === member.tmux.id && pane.sessionCreated === member.tmux.created).sort(compareIds);
    // Duplicate saved connections can describe one host. Accept them only when
    // their member-specific status agrees; never select an arbitrary alias.
    const next = JSON.stringify(panes.map(pane => [pane.paneId, pane.state, pane.state === "blocked" ? pane.kind ?? null : null]));
    if (signature !== undefined && next !== signature) return fallback;
    signature = next;
    candidates = panes;
  }
  const report = candidates?.filter((pane): pane is TmuxProgramPane & {state: NonNullable<TmuxProgramPane["state"]>} => pane.state !== null)
    .sort((a, b) => priority[a.state] - priority[b.state] || compareIds(a, b))[0];
  if (!report) return fallback;
  const kind = report.state === "blocked" ? report.kind : undefined;
  return { state: report.state, ...(kind ? {kind} : {}), source: "program", label: `${kind ? kindLabels[kind] : programLabels[report.state]}（程序状态）` };
}
