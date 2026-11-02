import { useState, type CSSProperties } from "react";
import { X, ArrowUpRight, Crown, Server } from "lucide-react";
import { Button } from "./ui/button";
import TeamMemberAvatar, { teamAvatarShirt } from "./TeamMemberAvatar";
import { isLeadMember } from "../lib/agentSessions";
import { memberConnection, memberKey, type TeamMember } from "../lib/teamMembers";
import { memberDisplay, type MachinesMap } from "../lib/memberDisplay";
import { serviceMemberAvatar, serviceMemberStatus } from "../lib/teamServicePresentation";
import { projectDisplayTitle } from "../lib/teamServiceProjects";
import type { TeamServiceState } from "../lib/teamService";
import type { CollaborationSession } from "../lib/collaboration";
import type { ServerEntry } from "../types";
import "./Collaboration.css";
import "./AdventurePanel.css";
import { activityStatus } from "../lib/memberActivity";

interface Props {
  service: TeamServiceState;
  servers: ServerEntry[];
  sessions: CollaborationSession[];
  onOpen: (member: TeamMember, server: ServerEntry) => Promise<void>;
  onClose: () => void;
}
const priority: Record<string, number> = { bad: 0, warn: 1, wait: 2, run: 3, idle: 4 };

export default function AdventurePanel({ service, servers, sessions, onOpen, onClose }: Props) {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const projects = service.projects.map(project => {
    const snapshot = service.snapshots[project];
    const unavailable = snapshot?.offline || (snapshot?.status ?? service.status.state) !== "online";
    const missing = service.catalog?.state === "ready" && !service.catalog.projects.includes(project);
    const leads = (missing ? [] : snapshot?.members ?? []).filter(member => isLeadMember(member)).map(member => {
      const key = JSON.stringify([service.url, project, memberKey(member)]);
      const live = snapshot?.live[memberKey(member)];
      const display = memberDisplay(member, live, snapshot?.machines as MachinesMap);
      const machine = display.machine ? snapshot?.machines[display.machine] as { online?: boolean } | undefined : undefined;
      const { server } = memberConnection(member, servers, sessions);
      // Leads show only the activity, never a card badge (plan §3.4); pane status when the service has none.
      const status = (live?.activity && activityStatus(live.activity, false, Date.now() / 1000, true))
        || serviceMemberStatus(member, live, undefined, Date.now() / 1000, true).status;
      const issue = unavailable ? "团队服务离线" : machine?.online === false ? "机器离线"
        : live?.match === "replaced" ? "会话已替换" : !server ? "未找到对应连接" : undefined;
      // Offline, replaced or unreachable Leads keep their pose but lose colour.
      const avatar = serviceMemberAvatar(member, live);
      return { member, key, display, server, status: issue ? { ...status, tone: "offline", label: issue } : status,
        avatar: issue ? { ...avatar, state: "unknown" as const } : avatar };
    });
    leads.sort((a, b) => (priority[a.status.tone] ?? 5) - (priority[b.status.tone] ?? 5));
    const empty = missing ? "项目不可用或无权访问" : !snapshot
      ? service.status.state === "connecting" ? "正在读取名单…" : "名单不可用"
      : unavailable ? "名单不可用 · 团队服务离线" : "未登记 Lead";
    return { project, projectTitle: projectDisplayTitle(project, service), leads, empty, rank: Math.min(6, ...leads.map(lead => priority[lead.status.tone] ?? 5)) };
  }).sort((a, b) => a.rank - b.rank || a.project.localeCompare(b.project));

  const open = async (key: string, member: TeamMember, server: ServerEntry) => {
    if (pending[key]) return;
    setPending(previous => ({ ...previous, [key]: true }));
    setErrors(previous => ({ ...previous, [key]: "" }));
    try { await onOpen(member, server); }
    catch (error) { setErrors(previous => ({ ...previous, [key]: String(error instanceof Error ? error.message : error) })); }
    finally { setPending(previous => ({ ...previous, [key]: false })); }
  };

  return <aside className="adventure-panel team-dynamics" aria-label="冒险团">
    <header data-panel-drag-handle tabIndex={0}>
      <strong>冒险团</strong>
      <Button variant="ghost" size="icon-sm" aria-label="关闭冒险团" onClick={onClose}><X size={16}/></Button>
    </header>
    <div className="adventure-projects">
      {!service.url ? <p className="adventure-empty">未配置团队服务</p>
        : !projects.length ? <p className="adventure-empty">未订阅项目</p>
        : projects.map(({ project, projectTitle, leads, empty }) => {
          const solo = leads.length === 1;
          return <section key={project} aria-label={projectTitle} className={`adventure-card${solo ? " is-solo" : ""}`}>
            {solo ? null : <div className="adventure-card-head">
              {leads.length ? null : <span className="adventure-avatar is-vacant" aria-hidden="true"><VacantSeat/></span>}
              <h3>{projectTitle}</h3>
            </div>}
            {leads.length ? leads.map(({ member, key, display, server, status, avatar }) => <div key={key} className="adventure-lead-row">
              <div className="adventure-lead">
                <span className="adventure-avatar" style={{"--avatar-tint": teamAvatarShirt(project)} as CSSProperties}>
                  <TeamMemberAvatar memberId={project} status={avatar} scale={solo ? 2 : 1}/>
                  <Crown className="adventure-crown" size={solo ? 14 : 10} aria-hidden="true"/>
                </span>
                <span className="adventure-identity">
                  {solo ? <h3>{projectTitle}</h3> : <strong>{display.title}</strong>}
                  <small className="adventure-meta">
                    <span className="adventure-meta-agent">{[solo ? display.title : "", display.subtitle].filter(Boolean).join(" · ")}</span>
                    <span className="adventure-meta-machine"><Server size={10} aria-hidden="true"/>{display.machine ?? "机器未知"}</span>
                  </small>
                </span>
                <span className={`adventure-status is-${status.tone}`}>{pending[key] ? "正在打开…" : status.label}</span>
                <button className="adventure-open" disabled={!server || pending[key]} aria-label={`打开 Lead · ${project} · ${display.title}`}
                  title={[display.title, display.subtitle, member.email].filter(Boolean).join("\n")} onClick={() => server && void open(key, member, server)}>
                  <ArrowUpRight size={14} aria-hidden="true"/>
                </button>
              </div>
              {errors[key] && <p className="adventure-error" role="alert">{errors[key]}</p>}
            </div>) : <p className="adventure-empty">{empty}</p>}
          </section>;
        })}
    </div>
  </aside>;
}

/** The office's empty chair: a seat waiting for its Lead. */
function VacantSeat() {
  return <svg width={28} height={32} viewBox="0 0 28 32" shapeRendering="crispEdges">
    <path className="adventure-vacant-chair" d="M7 8h14v8H7zm2 8h10v6H9zm-2 6h14v3H7z"/>
    <path className="adventure-vacant-ground" d="M3 29h22v1H3z"/>
  </svg>;
}
