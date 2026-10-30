import {teamPanelStatus} from "../lib/teamPanelStatus";
import TeamServiceAi from "./TeamServiceAi";
import {serviceAi} from "../lib/serviceAi";
import type { TeamLive } from "../lib/teamService";
import { memberTaskTarget, memberTaskSession, serviceMemberStatus } from "../lib/teamServicePresentation";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {ExternalLink,Plus,RefreshCw} from "lucide-react";
import {type CollaborationProfile} from "../lib/collaboration";
import {memberConnection,memberKey,type TeamMember} from "../lib/teamMembers";
import {memberDisplay} from "../lib/memberDisplay";
import type {TeamNavigation} from "./TeamMembers";
import {Button} from "./ui/button";
import type {BoardSource} from "../lib/taskLookup";
import {STATUS_GROUPS,ago,briefKey,taskBrief,type TaskBrief,isLeadMember,liveSnapshot,rankMembers,summarizeTeam,useAgentSessions,type LiveSessions,type LiveStatus,type StatusGroup} from "../lib/agentSessions";
import {useTaskLookup,LookupOutcome} from "./TaskLookup";
import TeamLiveSummary from "./TeamLiveSummary";
import TeamOffice from "./TeamOffice";
import type { OfficeSnapshot } from "../lib/teamOffice";



/** Groups rendered as one compact row per member; everything else gets a full card. */
const COMPACT_GROUPS:ReadonlySet<StatusGroup>=new Set(["lead","available","other","rosterWorking","rosterIdle","rosterUnknown"]);
const FILTER_KEYS:readonly StatusGroup[]=["attention","waitLead","available"];
/** The team list is worker-only; Lead navigation stays in the compact header. */
const GROUP_ORDER:readonly {key:StatusGroup;label:string;title?:string}[]=[
  ...STATUS_GROUPS.filter(g=>g.key!=="lead"),
];

/** `live`: the panel's shared collector data (so the merged view shows one snapshot); polled here when omitted. */
export default function TeamDynamics({sessionId,profile,navigation,members:rosterMembers,board,live:shared,
  serviceLive,serviceAi:aiMap={},aiEnabled,serviceIdentity="",onRefresh,onAddMember,disabled,more,addForm,renderMemberAdmin,pinnedKeys,officeSnapshot,officeVisible=true,onPopOut,onRoomOpenChange}:{
  sessionId:string;profile:CollaborationProfile;navigation:TeamNavigation;members:TeamMember[];onUpdated:()=>Promise<void>;board?:BoardSource;live?:LiveSessions;
  serviceLive?:Record<string,TeamLive>;
  serviceAi?:Record<string,unknown>; aiEnabled?:boolean|null; serviceIdentity?:string;
  /** Shell actions owned by TeamMembers: the merged view keeps one toolbar row. */
  onRefresh?:()=>void;onAddMember?:()=>void;disabled?:boolean;more?:ReactNode;addForm?:ReactNode;
  /** Management block (notes, connection, edit/update/remove) owned by TeamMembers, placed in each member's details. */
  renderMemberAdmin?:(member:TeamMember)=>ReactNode;
  /** Rows that must stay expanded while the shell is editing them (notes editor / terminal update). */
  pinnedKeys?:string[];
  /** Pixel room, shared by the team panel and the collaboration panel. */
  officeSnapshot?:OfficeSnapshot; officeVisible?:boolean; onPopOut?:()=>Promise<void>;
  onRoomOpenChange?:(open:boolean)=>void;
}){
  const self={...profile,username:navigation.server.username};
  const isLead=(m:TeamMember)=>serviceLive === undefined ? isLeadMember(m,self) : /^lead\b/i.test(m.role.trim());
  const members=rosterMembers.filter(m=>!isLead(m));      // Worker rows feed the shared live collector.
  const own=useAgentSessions(shared?undefined:board,members);
  const live=shared??own;
  const snapshot=liveSnapshot(live);
  const leadMember=rosterMembers.find(isLead);
  const hasServiceStatus=serviceLive !== undefined && members.some(member=>serviceLive[memberKey(member)]?.match!=="no_agent");
  const ranked=rankMembers(members,snapshot,isLead).map(row=>{const original=row.session; const presented=serviceLive === undefined || serviceLive[memberKey(row.member)]?.match === "no_agent" ? row : {
    ...row,...serviceMemberStatus(row.member,serviceLive[memberKey(row.member)],row.session,snapshot?.now??Date.now()/1000,isLead(row.member)),
  }; return {...presented,status:teamPanelStatus(row.member,presented.status,original,live,isLead(row.member))};
  }).sort((a,b)=>a.status.rank-b.status.rank||a.index-b.index);
  const taskLookup = useTaskLookup(board);
  const [serviceBriefs,setServiceBriefs] = useState<{scope:string;values:Record<string,TaskBrief>}>({scope:"",values:{}});
  const targetOf = (member:TeamMember,session?:ReturnType<typeof rankMembers>[number]["session"]) => serviceLive === undefined ? (session?.taskCode ? {project:session.project,code:session.taskCode} : undefined) : memberTaskTarget(member,memberTaskSession(member,snapshot?.sessions??[]));
  const taskTargets = [...new Map(ranked.flatMap(row=>{const target=targetOf(row.member,row.session);return target?[[briefKey(target.project,target.code),target] as const]:[];})).values()];
  const taskScope = JSON.stringify([serviceIdentity,board?.key,taskTargets]);
  useEffect(()=>{
    taskLookup.clear();
    if (!board || serviceLive === undefined) return;
    let active=true;
    void Promise.all(taskTargets.map(async target=>{
      try{return [briefKey(target.project,target.code),await taskBrief({...board,key:JSON.stringify([board.key,serviceIdentity])},target.project,target.code)] as const;}catch{return undefined;}
    })).then(items=>{if(active)setServiceBriefs({scope:taskScope,values:Object.fromEntries(items.filter((item): item is readonly [string,TaskBrief]=>!!item?.[1])) as Record<string,TaskBrief>});});
    return()=>{active=false;};
  },[taskScope]);
  const pinned=new Set(pinnedKeys??[]);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState("");
  // Filter and group folding are view state only: never persisted, reset on a new session/panel.
  const [filter,setFilter]=useState<StatusGroup>();
  const [openGroups,setOpenGroups]=useState<Record<string,boolean>>({});
  // Per-member expansion, keyed by memberKey: a member moving to another group keeps its state.
  const [openMembers,setOpenMembers]=useState<Record<string,boolean>>({});
  const [roomOpen,setRoomOpen]=useState(false);
  const [officeError,setOfficeError]=useState("");
  const running=useRef(false);
  const alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const connection=(member:TeamMember)=>{
    const sessions=[...(navigation.sessions??[]),{pane:{server:navigation.server},backendId:sessionId}];
    return memberConnection(member,navigation.servers,sessions);
  };
  const perform=async(action:()=>Promise<void>)=>{
    if(running.current)return;
    running.current=true;setBusy(true);setNotice("");
    try{await action();}catch(e){if(alive.current)setNotice(e instanceof Error?e.message:String(e));}
    finally{running.current=false;if(alive.current)setBusy(false);}
  };
  // The room consumes the same collection gate as the team panel: App turns it into
  // inlineRoomOpen and pauses/stops collecting when the panel is closed.
  useEffect(()=>{onRoomOpenChange?.(roomOpen);return()=>onRoomOpenChange?.(false);},[roomOpen,onRoomOpenChange]);
  // Board offline / still loading: there are no count chips, so a leftover filter would trap the
  // list on "没有符合的成员" with no way to clear it. Drop the filter with the summary.
  const liveReady=hasServiceStatus || !!snapshot;
  useEffect(()=>{if(!liveReady)setFilter(undefined);},[liveReady]);

  const toggleFilter=(key:StatusGroup)=>setFilter(old=>old===key?undefined:key);
  const activeFilter=liveReady?filter:undefined;                   // never filter without live counts
  const groupOpen=(key:StatusGroup)=>{
    if(activeFilter===key)return true;                             // a filtered group must be visible
    return openGroups[key]??!COMPACT_GROUPS.has(key);              // idle rows start folded
  };
  const filtered=!!activeFilter;
  const memberOpen=(key:string)=>pinned.has(key)||!!openMembers[key];
  const toggleMember=(key:string,open:boolean)=>{
    if(pinned.has(key))return;                                     // forced open while the shell edits it
    setOpenMembers(old=>old[key]===open?old:{...old,[key]:open});
  };
  const renderMember=(row:{member:TeamMember;session?:ReturnType<typeof rankMembers>[number]["session"];status:LiveStatus})=>{
    const {member:m,session,status}=row;
    const compact=COMPACT_GROUPS.has(status.group);
    const key=memberKey(m);
    const display=memberDisplay(m,{model:session?.model,host:session?.host});
    const ai=serviceAi(aiMap[key]);
    const aiTarget=serviceIdentity ? {project:profile.project,key,identity:serviceIdentity} : undefined;
    const open=memberOpen(key);
    const {server}=connection(m);
    const target=targetOf(m,session);
    const brief=target ? serviceLive !== undefined ? (serviceBriefs.scope===taskScope?serviceBriefs.values[briefKey(target.project,target.code)]:undefined) : live.briefs[briefKey(target.project,target.code)] : undefined;
    const now=snapshot?.now??Math.floor(Date.now()/1000);
    const identity=<strong className="team-ai-identity" title={`${display.title} · ${m.tmux.name}`}>{display.title}{display.subtitle&&<small className="team-live-subtitle">{display.subtitle}</small>}</strong>;
    const actions=<span className="team-ai-row-actions">
      <Button size="icon-sm" variant="ghost" disabled={!server||busy} aria-label={`打开 · ${display.title}`} title={server?"打开终端":"未找到对应连接"} onClick={e=>{e.preventDefault();e.stopPropagation();if(server)void perform(()=>navigation.onOpen(m,server));}}><ExternalLink size={14}/></Button>
    </span>;
    // 只有确实有上一张卡时才占一格；没有就不放空信息（同「无当前卡」不渲染的理由）。
    const taskLine=target?<button type="button" className="team-card-line2 team-task-link" disabled={!board}
      title={[target.code,brief?.title||brief?.brief].filter(Boolean).join(" · ")}
      onClick={event=>{event.preventDefault();event.stopPropagation();void taskLookup.open(target.project,target.code);}}>
      <b>{target.code}</b>{(brief?.title||brief?.brief)&&<span className="team-card-brief"> · {brief.title||brief.brief}</span>}
    </button>:null;
    const rosterNote=!session&&m.currentTask?.trim()?m.currentTask.trim().split(/\r?\n/)[0]:"";
    const lastCard=session?.taskCode
      ?<span className="team-compact-card" title={`上一张卡 ${session.taskCode}${brief?.brief||brief?.title?` · ${brief.brief||brief.title}`:""}`}>{session.taskCode} ✓</span>
      :rosterNote?<span className="team-compact-card is-roster" title={m.currentTask}>{rosterNote}</span>:null;
    const details=<div className="team-card-expanded">
      {session&&<p className="team-live-detail">分支 {session.branch||"—"} · {session.commitHash||"—"}{session.lastLine&&<><br/>最后一行：{session.lastLine}</>}</p>}
      <TeamServiceAi ai={ai} enabled={aiEnabled}/>
      {open&&renderMemberAdmin?.(m)}
      <Button size="sm" aria-label={`打开终端 · ${display.title}`} disabled={!server||busy} onClick={()=>server&&void perform(()=>navigation.onOpen(m,server))}>打开终端</Button>
    </div>;
    if(compact){
      return <details className={`team-compact-row team-live-row${status.needsHuman?" team-live-alert":status.group==="waitLead"?" team-live-wait-lead":""}`} key={key} open={open} onToggle={e=>toggleMember(key,(e.currentTarget as HTMLDetailsElement).open)} data-state={session?.state??"none"} data-group={status.group}>
        <summary className="team-compact-head">
          <span className={`team-live-dot is-${status.tone}`} aria-hidden="true"/>
          {identity}
          <span className="team-compact-state"><span className={`team-live-badge is-${status.tone}`} title={status.title}>{status.label}</span>{status.duration&&<small>{status.duration}</small>}</span>
          {serviceLive === undefined ? lastCard : taskLine}
          <TeamServiceAi ai={ai} enabled={aiEnabled} target={aiTarget} compact/>
          {actions}
        </summary>
        {details}
      </details>;
    }
    return <details className={`team-ai-row team-live-row team-live-card${status.needsHuman?" team-live-alert":status.group==="waitLead"?" team-live-wait-lead":""}`} key={key} open={open} onToggle={e=>toggleMember(key,(e.currentTarget as HTMLDetailsElement).open)} data-state={session?.state??"none"} data-group={status.group}>
      <summary className="team-card-head">
        <span className={`team-live-dot is-${status.tone}`} aria-hidden="true"/>
        {identity}
        <span className="team-live-status"><span className={`team-live-badge is-${status.tone}`} title={status.title}>{status.label}</span>{status.duration&&<small>{status.duration}</small>}</span>
        {actions}
        {serviceLive !== undefined ? taskLine : session?.taskCode
          ?<div className="team-card-line2"><b>{session.taskCode}</b>{session.taskStatus&&<em>{live.statusNames[briefKey(session.project,session.taskStatus)]??session.taskStatus}</em>}{(brief?.brief||brief?.title)&&<span className="team-card-brief">{brief.brief||brief.title}</span>}</div>
          :!session&&m.currentTask?.trim()
            ?<div className="team-card-line2 is-roster" title={m.currentTask}><b>Lead 备注</b><span className="team-card-brief">{m.currentTask.trim().split(/\r?\n/)[0]}</span></div>
            :null}
        <TeamServiceAi ai={ai} enabled={aiEnabled} target={aiTarget} compact/>
        {(session?.commitTime||session?.model||session?.host||session?.dirty||(!session&&m.host))
          ?<div className="team-card-line3" title={[session?.commitHash,session?.branch].filter(Boolean).join(" · ")}>
            {session&&session.commitTime>0&&<span>提交 {ago(session.commitTime,now)}前 · {session.commitSubject}</span>}
            {session?.model&&<span>{session.model}</span>}
            {display.machine&&<span>{display.machine}</span>}
            {session&&session.dirty>0&&<span className="team-live-dirty">未提交 {session.dirty} 个文件</span>}
          </div>
          :null}
      </summary>
      {details}
    </details>;
  };
  return <section className="team-dynamics" aria-label="团队动态">
    <div className="team-toolbar">
      <div className="team-toolbar-title"><strong>团队 · {members.length} 人</strong><small>{serviceLive !== undefined?"团队服务实时同步":"看板实时 · 每分钟刷新"}</small></div>
      {leadMember&&(()=>{const {server}=connection(leadMember);const display=memberDisplay(leadMember);const status=serviceMemberStatus(leadMember,serviceLive?.[memberKey(leadMember)],undefined,snapshot?.now??Date.now()/1000,true).status;return <Button size="sm" variant="ghost" className="team-lead-entry" aria-label={`打开 Lead · ${display.title}`} disabled={!server||busy} onClick={()=>server&&void perform(()=>navigation.onOpen(leadMember,server))}><span className={`team-live-dot is-${status.tone}`} aria-hidden="true"/>{display.title}</Button>;})()}
      <TeamLiveSummary serviceMode={hasServiceStatus} board={board} live={live} summary={summarizeTeam(ranked,snapshot??(hasServiceStatus?{sessions:[],now:Date.now()/1000,ttlSeconds:180,alertAfterSeconds:600,collectedAt:0}:undefined))} filter={activeFilter} onFilter={toggleFilter}/>
      {activeFilter&&<Button size="sm" variant="ghost" onClick={()=>setFilter(undefined)}>清除筛选</Button>}
      <div className="team-toolbar-actions">
        {officeSnapshot&&<Button size="sm" variant={roomOpen?"secondary":"ghost"} aria-pressed={roomOpen} onClick={()=>setRoomOpen(open=>!open)}>房间</Button>}
        <Button size="icon-sm" variant="ghost" aria-label="刷新成员" title="刷新成员" disabled={!!disabled||busy} onClick={()=>onRefresh?.()}><RefreshCw size={15}/></Button>
        <Button size="sm" disabled={!!disabled||busy} onClick={()=>onAddMember?.()}><Plus size={14}/> 添加成员</Button>
        <p>AI 摘要由团队服务生成</p>
        {more&&<details className="team-ai-options team-toolbar-details"><summary>更多</summary><div className="team-more-body">{more}</div></details>}
      </div>
    </div>
    {(busy||notice)&&<small role="status">{busy?"正在更新…":notice}</small>}
    {officeSnapshot&&roomOpen
      ? <div className="team-room-view">
          {officeError&&<p role="alert">{officeError}</p>}
          <TeamOffice snapshot={officeSnapshot} visible={officeVisible&&roomOpen} onPopOut={onPopOut?()=>{
            setOfficeError("");void onPopOut().catch(()=>setOfficeError("房间窗口未能打开，请重试。"));
          }:undefined}/>
        </div>
      : <>
    <LookupOutcome state={taskLookup} source={board} dismissible/>
    {addForm}
    {GROUP_ORDER.map(group=>{
      if(filtered&&group.key!==activeFilter)return null;
      const rows=ranked.filter(r=>r.status.group===group.key);
      if(!rows.length&&!filtered)return null;
      const open=groupOpen(group.key);
      return <section className={`team-live-group team-live-group-${group.key}${COMPACT_GROUPS.has(group.key)?" is-compact":""}`} key={group.key} aria-label={`${group.label}成员`}>
        <details open={open} onToggle={e=>{
          if(activeFilter===group.key){e.currentTarget.open=true;return;}   // 筛选强制展开，不记作用户状态
          const next=(e.currentTarget as HTMLDetailsElement).open;setOpenGroups(old=>old[group.key]===next?old:{...old,[group.key]:next});
        }}>
          <summary className="team-activity-heading" title={group.title}><strong>{group.label}</strong><span>{rows.length}</span></summary>
          <div className="team-live-group-body">
            {rows.length?rows.map(renderMember):<p className="team-live-empty" role="status">没有符合的成员</p>}
          </div>
        </details>
      </section>;
    })}
      </>}
  </section>;
}
