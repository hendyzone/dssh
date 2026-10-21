import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "./ui/button";
import TeamMemberAvatar from "./TeamMemberAvatar";
import type { OfficeSnapshot } from "../lib/teamOffice";
import "./TeamOffice.css";

/** The same presentation component serves the inline room and the isolated popup. */
export default function TeamOffice({snapshot, visible = true, onPopOut}: {
  snapshot: OfficeSnapshot; visible?: boolean; onPopOut?: () => void;
}) {
  const [scale,setScale] = useState<1|2|3>(1);
  const [collapsed,setCollapsed] = useState<Set<string>>(() => new Set());
  const [hidden,setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange",update);
    return () => document.removeEventListener("visibilitychange",update);
  }, []);
  const paused = !visible || hidden;
  return <section className="team-office" aria-label="公司办公室" data-paused={String(paused)}>
    <header className="office-toolbar"><strong>公司办公室</strong><div>
      <label>像素缩放 <select aria-label="房间像素缩放" value={scale} onChange={event => setScale(Number(event.target.value) as 1|2|3)}>
        <option value="1">1×</option><option value="2">2×</option><option value="3">3×</option>
      </select></label>{onPopOut && <Button size="sm" variant="outline" onClick={onPopOut}>弹出窗口</Button>}
    </div></header>
    <p className="office-coverage">显示本机已登记的团队；未连接的 Lead 工作区暂不可读取。</p>
    <div className="office-projects">
      {!snapshot.projects.length && <p className="office-empty">暂无已登记的团队。先在 Lead 终端的团队面板登记项目。</p>}
      {snapshot.projects.map(project => {
        const closed = collapsed.has(project.id);
        return <section className="office-project" aria-label={`项目 ${project.name}`} key={project.id}>
          <button className="office-project-sign" aria-label={`${closed?"展开":"折叠"}项目 ${project.name}`} aria-expanded={!closed} onClick={() => setCollapsed(previous => {
            const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next;
          })}><span aria-hidden="true">{closed?"▸":"▾"}</span> {project.name}<small>{project.sources.reduce((count,source)=>count+source.members.length,0)} 人</small></button>
          <div hidden={closed} className="office-project-floor">
            {project.sources.map(source => <section className="office-source" key={source.id} aria-label={source.label}>
              <p className="office-source-label">{source.label}</p>
              {source.availability !== "ready" ? <p role="status" className="office-source-notice">{source.notice}</p>
                : !source.members.length ? <p className="office-source-notice">此团队尚未登记成员。</p> : null}
              <div className="office-desks" style={{"--office-station-width":`${Math.max(128,96*scale)}px`} as CSSProperties}>
                {source.members.map(member => <article className={`office-station${member.isLead?" is-lead":""}`} key={member.id} data-member-id={member.id} aria-label={`工位 ${member.name}`}>
                  <div className="office-pixels" style={{width:96*scale,height:64*scale}}>
                    <svg className="office-furniture" width={96*scale} height={64*scale} viewBox="0 0 96 64" shapeRendering="crispEdges" aria-hidden="true">
                      <path className="office-floor-shadow" d="M5 59h86v3H5z"/>
                      <path className="office-desk-edge" d="M8 38h80v6H8zm4 6h5v15h-5zm67 0h5v15h-5z"/>
                      <path className="office-desk-top" d="M10 36h76v4H10z"/>
                      <path className="office-monitor-frame" d="M53 13h26v19H53zm11 19h4v4h-4z"/>
                      <path className="office-monitor-screen" d="M56 16h20v13H56z"/>
                      <path className="office-monitor-lines" d="M59 20h8v2h-8zm0 4h13v1H59z"/>
                      {member.isLead && <><path className="office-lead-plaque" d="M67 40h16v6H67z"/><path className="office-monitor-lines" d="M70 42h10v2H70z"/></>}
                    </svg>
                    <div className="office-person" style={{left:22*scale,top:7*scale}}><TeamMemberAvatar memberId={member.paletteKey} status={member.status} scale={scale} motionEnabled={snapshot.animationEnabled} paused={paused || closed}/></div>
                  </div>
                  <div className="office-station-name">{member.isLead && <span className="office-lead-label">Lead</span>} <strong title={member.name}>{member.name}</strong></div>
                  <p className="office-member-status">{member.status.label}</p>
                  <p className="office-member-task" title={member.taskText} data-source={member.taskSource}>{member.taskText}</p>
                  {member.taskSource === "manual" && <small className="office-task-source">成员手写</small>}
                </article>)}
              </div>
            </section>)}
          </div>
        </section>;
      })}
    </div>
    <footer className="office-mailbox"><span aria-hidden="true">✉</span> 邮件动态不可用</footer>
  </section>;
}
