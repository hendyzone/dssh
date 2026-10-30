import { useState } from "react";
import { X, ArrowUpRight } from "lucide-react";
import { Button } from "./ui/button";
import { isLeadMember } from "../lib/agentSessions";
import { memberConnection, memberKey, type TeamMember } from "../lib/teamMembers";
import { memberDisplay, type MachinesMap } from "../lib/memberDisplay";
import { serviceMemberStatus } from "../lib/teamServicePresentation";
import type { TeamServiceState } from "../lib/teamService";
import type { CollaborationSession } from "../lib/collaboration";
import type { ServerEntry } from "../types";
import "./Collaboration.css";
import "./AdventurePanel.css";

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
      const status = serviceMemberStatus(member, live, undefined, Date.now() / 1000, true).status;
      const issue = unavailable ? "团队服务离线" : machine?.online === false ? "机器离线"
        : live?.match === "replaced" ? "会话已替换" : !server ? "未找到对应连接" : undefined;
      return { member, key, display, server, status: issue ? { ...status, tone: "offline", label: issue } : status };
    });
    leads.sort((a, b) => (priority[a.status.tone] ?? 5) - (priority[b.status.tone] ?? 5));
    const empty = missing ? "项目不可用或无权访问" : !snapshot
      ? service.status.state === "connecting" ? "正在读取名单…" : "名单不可用"
      : unavailable ? "名单不可用 · 团队服务离线" : "未设置 Lead";
    return { project, leads, empty, rank: Math.min(6, ...leads.map(lead => priority[lead.status.tone] ?? 5)) };
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
        : projects.map(({ project, leads, empty }) => <section key={project} aria-label={project} className="adventure-project">
          <h3>{project}</h3>
          {leads.length ? leads.map(({ member, key, display, server, status }) => <div key={key}>
            <button className="adventure-lead" disabled={!server || pending[key]} aria-label={`打开 Lead · ${project} · ${display.title}`}
              onClick={() => server && void open(key, member, server)}>
              <span className={`team-live-dot is-${status.tone}`} aria-hidden="true"/>
              <span className="adventure-identity"><strong>{display.title}</strong>
                <small>{[display.subtitle, display.machine ?? "机器未知"].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="adventure-status">{pending[key] ? "正在打开…" : status.label}</span>
              <ArrowUpRight size={14} aria-hidden="true"/>
            </button>
            {errors[key] && <p className="adventure-error" role="alert">{errors[key]}</p>}
          </div>) : <p className="adventure-empty">{empty}</p>}
        </section>)}
    </div>
  </aside>;
}
