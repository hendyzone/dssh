import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "./ui/button";
import OfficeMail, {officeStationAnchor} from "./OfficeMail";
import TeamMemberAvatar from "./TeamMemberAvatar";
import type { OfficeSnapshot } from "../lib/teamOffice";
import "./TeamOffice.css";

/** Original pixel furniture, shared by occupied stations and the unassigned desks. */
function Desk({scale, lead = false}: {scale:1|2|3;lead?:boolean}) {
  return <svg className="office-furniture" width={96*scale} height={72*scale} viewBox="0 0 96 72" shapeRendering="crispEdges" aria-hidden="true">
    <path className="office-floor-shadow" d="M7 59h79v3h4v3H11v-3H7z"/>
    <path className="office-chair" d="M24 31h20v18H24zm5 18h10v9H29zm-5 9h20v3H24z"/>
    <path className="office-desk-leg" d="M10 42h5v18h-5zm70 0h5v18h-5z"/>
    <path className="office-desk-front" d="M8 38h80v9H8z"/>
    <path className="office-desk-top" d="M12 34h72v2h4v4H8v-4h4z"/>
    <path className="office-desk-highlight" d="M12 34h72v2H12z"/>
    <path className="office-monitor-frame" d="M52 13h29v20H52zm12 20h5v3h-5zm-5 3h15v2H59z"/>
    <path className="office-monitor-screen" d="M55 16h23v14H55z"/>
    <g className="office-screen-code office-motion"><path d="M58 19h8v2h-8zm0 4h14v1H58zm0 3h5v1h-5z"/><path className="office-screen-cursor" d="M66 26h3v1h-3z"/></g>
    <path className="office-paper" d="M57 39h13v2H57z"/>
    <path className="office-mug" d="M76 34h5v5h-5zm5 1h2v3h-2z"/>
    {lead && <><path className="office-lead-plaque" d="M10 43h13v5H10z"/><path className="office-plaque-mark" d="M13 44h7v2h-7z"/></>}
  </svg>;
}
function EmptyDesks({scale}: {scale:1|2|3}) {
  return <div className="office-empty-desks" aria-hidden="true">{[0,1,2].map(index=><div className="office-empty-desk office-pixels" aria-hidden="true" key={index} style={{width:96*scale,height:72*scale}}><Desk scale={scale}/></div>)}</div>;
}
function UpperWall() {
  return <div className="office-upper-wall" aria-hidden="true"><svg width="640" height="112" viewBox="0 0 320 56" shapeRendering="crispEdges">
    <path className="office-window-frame" d="M20 8h63v37H20zm132 0h63v37h-63z"/>
    <path className="office-window-sky" d="M24 12h55v29H24zm132 0h55v29h-55z"/>
    <path className="office-cloud" d="M28 18h12v-3h10v3h8v4H28zm132 5h12v-3h13v3h9v4h-34z"/>
    <path className="office-window-frame" d="M50 10h3v33h-3zm132 0h3v33h-3zM20 27h63v3H20zm132 0h63v3h-63z"/>
    <path className="office-window-sill" d="M17 43h69v4H17zm132 0h69v4h-69z"/>
    <path className="office-clock-rim" d="M108 11h18v3h3v18h-3v3h-18v-3h-3V14h3z"/>
    <path className="office-clock-face" d="M109 15h16v16h-16z"/><path className="office-clock-hand" d="M116 17h2v8h5v2h-7z"/>
    <path className="office-shelf" d="M245 39h54v4h-54z"/><path className="office-pot" d="M262 30h16v9h-16z"/>
    <path className="office-leaf" d="M268 14h4v18h-4zm-10 4h10v4h-10zm-4-5h8v5h-8zm18 10h11v4h-11zm7-6h8v6h-8z"/>
  </svg></div>;
}
const shortStatus = {working:"工作中",idle:"空闲",unknown:"待确认",done:"已完成",blocked:"等待处理",error:"错误"};
/** The same presentation component serves the inline room and the isolated popup. */
export default function TeamOffice({snapshot, visible = true, onPopOut}: {
  snapshot: OfficeSnapshot; visible?: boolean; onPopOut?: () => void;
}) {
  const mailContainer=useRef<HTMLDivElement>(null);
  const [scale,setScale] = useState<1|2|3>(2);
  const [collapsed,setCollapsed] = useState<Set<string>>(() => new Set());
  const [hidden,setHidden] = useState(() => document.hidden);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange",update);
    return () => document.removeEventListener("visibilitychange",update);
  }, []);
  const paused = !visible || hidden;
  return <section className="team-office" aria-label="公司办公室" data-paused={String(paused)} data-motion={snapshot.animationEnabled?"on":"off"}>
    <header className="office-toolbar"><strong>公司办公室</strong><div>
      <label>像素缩放 <select aria-label="房间像素缩放" value={scale} onChange={event => setScale(Number(event.target.value) as 1|2|3)}>
        <option value="1">1×</option><option value="2">2×</option><option value="3">3×</option>
      </select></label>{onPopOut && <Button size="sm" variant="outline" onClick={onPopOut}>弹出窗口</Button>}
    </div></header>
    <p className="office-coverage">显示本机已登记的团队；未连接的 Lead 工作区暂不可读取。</p>
    <div className="office-projects" ref={mailContainer}>
      <UpperWall/>
      {!snapshot.projects.length && <div className="office-unassigned"><p className="office-empty">暂无已登记的团队。先在 Lead 终端的团队面板登记项目。</p><EmptyDesks scale={scale}/></div>}
      {snapshot.projects.map(project => {
        const closed = collapsed.has(project.id);
        return <section className="office-project" aria-label={`项目 ${project.name}`} key={project.id} data-paused={String(paused || closed)}>
          <button className="office-project-sign" aria-label={`${closed?"展开":"折叠"}项目 ${project.name}`} aria-expanded={!closed} onClick={() => setCollapsed(previous => {
            const next = new Set(previous); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next;
          })}><span aria-hidden="true">{closed?"▸":"▾"}</span> {project.name}<small>{project.sources.reduce((count,source)=>count+source.members.length,0)} 人</small></button>
          <div hidden={closed} className="office-project-floor">
            {!project.sources.length && <EmptyDesks scale={scale}/>}
            {project.sources.map(source => <section className="office-source" key={source.id} aria-label={source.label}>
              <p className="office-source-label">{source.label}</p>
              {source.availability !== "ready" ? <p role="status" className="office-source-notice">{source.notice}</p>
                : !source.members.length ? <p className="office-source-notice">此团队尚未登记成员。</p> : null}
              {!source.members.length && <EmptyDesks scale={scale}/>}
              <div className="office-desks" style={{"--office-station-width":`${Math.max(128,96*scale)}px`} as CSSProperties}>
                {source.members.map(member => <article className={`office-station${member.isLead?" is-lead":""}`} key={member.id} data-member-id={member.id} data-office-station={officeStationAnchor(source.id,member.id)} data-state={member.status.state} aria-label={`工位 ${member.name}`}>
                  <span className="office-sr-only">{member.status.label}</span>
                  <div className="office-pixels" style={{width:96*scale,height:72*scale}}>
                    <Desk scale={scale} lead={member.isLead}/>
                    <div className="office-person" style={{left:20*scale,top:14*scale}}><TeamMemberAvatar memberId={member.paletteKey} status={member.status} scale={scale} motionEnabled={snapshot.animationEnabled} paused={paused || closed}/></div>
                    <div className="office-desk-label" style={{top:51*scale,left:6*scale,right:6*scale}}><div className="office-station-name">{member.isLead && <span className="office-lead-label">Lead</span>} <strong title={member.name}>{member.name}</strong></div><span className="office-member-status" title={member.status.label}>{shortStatus[member.status.state]}</span></div>
                  </div>
                  <p className="office-member-task" title={`${member.taskSource==="manual"?"成员手写 · ":""}${member.taskText}`} data-source={member.taskSource}>{member.taskSource==="manual" && <span className="office-sr-only">成员手写 · </span>}{member.taskText}</p>
                </article>)}
              </div>
            </section>)}
          </div>
        </section>;
      })}
      <OfficeMail mail={snapshot.mail} paused={paused} motion={snapshot.animationEnabled} container={mailContainer} layoutKey={[scale,collapsed,snapshot.projects]}/>
    </div>
    <footer className="office-mailbox"><span aria-hidden="true">✉</span> {snapshot.mail?.availability==="ready"?"邮件动态已连接":snapshot.mail?.availability==="loading"?"正在连接邮件动态…":snapshot.mail?.availability==="error"?"邮件动态暂时失败":"邮件动态不可用"}</footer>
  </section>;
}
