import {useEffect,useRef,useState,type ReactNode} from "react";
import {invoke} from "@tauri-apps/api/core";
import {ExternalLink,Plus,RefreshCw,Sparkles} from "lucide-react";
import {collaborationRequest,type CollaborationProfile} from "../lib/collaboration";
import {memberConnection,memberKey,parseMember,type TeamMember} from "../lib/teamMembers";
import {excerptDigest,loadTeamAi,redactTerminal,protocolOf,configName} from "../lib/teamAi";
import type {TeamNavigation} from "./TeamMembers";
import {Button} from "./ui/button";
import type {ServerEntry} from "../types";
import type {BoardSource} from "../lib/taskLookup";
import {STATUS_GROUPS,ago,briefKey,isLeadMember,liveSnapshot,rankMembers,summarizeTeam,useAgentSessions,type LiveSessions,type LiveStatus,type StatusGroup} from "../lib/agentSessions";
import TeamLiveSummary from "./TeamLiveSummary";

type LiveConnection={sessionId:string;serverId?:string;host:string;port:number;username:string;tmux?:{id:string;created:number};tmuxWorkdir?:string};

const states={working:"工作中",waiting:"等待处理",idle:"空闲",unknown:"待确认"} as const;
type State=keyof typeof states;
class LeaseBusyError extends Error {}
type Clip={member:TeamMember;text:string;digest:string;source:string};
const sourceOf=(m:TeamMember)=>JSON.stringify([m.host,m.port,m.username,m.workdir,m.tmux.id,m.tmux.created]);

/** Groups rendered as one compact row per member; everything else gets a full card. */
const COMPACT_GROUPS:ReadonlySet<StatusGroup>=new Set(["lead","available","other","rosterWorking","rosterIdle","rosterUnknown"]);
const FILTER_KEYS:readonly StatusGroup[]=["attention","waitLead","available"];
/** Lead 排最后：「需要处理 / 等 Lead」才是第一眼要找的东西。 */
const GROUP_ORDER:readonly {key:StatusGroup;label:string;title?:string}[]=[
  ...STATUS_GROUPS.filter(g=>g.key!=="lead"), ...STATUS_GROUPS.filter(g=>g.key==="lead"),
];

/** `worker-<project>-<short>` → `<short>`; names that do not follow the convention stay whole. */
function shortTmuxName(member:TeamMember){
  const prefix=`worker-${member.project}-`;
  return member.tmux.name.startsWith(prefix)?member.tmux.name.slice(prefix.length):member.tmux.name;
}

/** Role is the primary name; the tmux short name is appended only when the role repeats in this team. */
function displayName(member:TeamMember,members:TeamMember[]){
  const duplicated=members.filter(m=>m.role===member.role).length>1;
  return {role:member.role,suffix:duplicated?shortTmuxName(member):""};
}

/** `live`: the panel's shared collector data (so the merged view shows one snapshot); polled here when omitted. */
export default function TeamDynamics({sessionId,profile,navigation,members:rosterMembers,onUpdated,board,live:shared,
  onRefresh,onAddMember,disabled,more,addForm,renderMemberAdmin,pinnedKeys}:{
  sessionId:string;profile:CollaborationProfile;navigation:TeamNavigation;members:TeamMember[];onUpdated:()=>Promise<void>;board?:BoardSource;live?:LiveSessions;
  /** Shell actions owned by TeamMembers: the merged view keeps one toolbar row. */
  onRefresh?:()=>void;onAddMember?:()=>void;disabled?:boolean;more?:ReactNode;addForm?:ReactNode;
  /** Management block (notes, connection, edit/update/remove) owned by TeamMembers, placed in each member's details. */
  renderMemberAdmin?:(member:TeamMember)=>ReactNode;
  /** Rows that must stay expanded while the shell is editing them (notes editor / terminal update). */
  pinnedKeys?:string[];
}){
  const self={...profile,username:navigation.server.username};
  const isLead=(m:TeamMember)=>isLeadMember(m,self);
  const members=rosterMembers.filter(m=>!isLead(m));      // Worker rows feed AI selection/summaries
  const own=useAgentSessions(shared?undefined:board,members);
  const live=shared??own;
  const snapshot=liveSnapshot(live);
  // Rows include the Lead: its details carry the same note/connection/update/remove actions.
  const ranked=rankMembers(rosterMembers,snapshot,isLead);
  // Display names only depend on the roster, so compute them once (was O(n²) per row).
  const names=new Map(rosterMembers.map(m=>[memberKey(m),displayName(m,rosterMembers)]));
  const pinned=new Set(pinnedKeys??[]);
  const [config,setConfig]=useState(loadTeamAi);
  const [selection,setSelection]=useState<string[]|null>(null);
  const selected=selection?.filter(id=>members.some(m=>memberKey(m)===id))??members.slice(0,10).map(memberKey);
  const [confirmAuto,setConfirmAuto]=useState(false);
  const [consent,setConsent]=useState("");
  const [clips,setClips]=useState<Clip[]>([]);
  const [auto,setAuto]=useState(false);
  const [allowAuto,setAllowAuto]=useState(false);
  const [busy,setBusy]=useState(false);
  const [singleBusy,setSingleBusy]=useState<string>();
  const [batchProgress,setBatchProgress]=useState("");
  const [notice,setNotice]=useState("");
  const [issues,setIssues]=useState<Record<string,string>>({});
  // Filter and group folding are view state only: never persisted, reset on a new session/panel.
  const [filter,setFilter]=useState<StatusGroup>();
  const [openGroups,setOpenGroups]=useState<Record<string,boolean>>({});
  // Per-member expansion, keyed by memberKey: a member moving to another group keeps its state.
  const [openMembers,setOpenMembers]=useState<Record<string,boolean>>({});
  const running=useRef(false);
  const revision=useRef(0);
  const alive=useRef(true);
  const owner=useRef(crypto.randomUUID());
  const latest=useRef(members);latest.current=members;
  useEffect(()=>{
    alive.current=true;
    const update=()=>{revision.current++;setConfig(loadTeamAi());setAuto(false);setAllowAuto(false);setClips([]);setConfirmAuto(false);setConsent("");};
    window.addEventListener("dssh-team-ai-config",update);
    return()=>{alive.current=false;revision.current++;window.removeEventListener("dssh-team-ai-config",update);};
  },[]);
  const connection=(member:TeamMember)=>{
    const sessions=[...(navigation.sessions??[]),{pane:{server:navigation.server},backendId:sessionId}];
    return memberConnection(member,navigation.servers,sessions);
  };
  const capture=async(version=revision.current,ids=selected,force=false)=>{
    const result:Clip[]=[];const errors:Record<string,string>={};
    for(const id of ids){
      if(!alive.current||version!==revision.current)break;
      const member=latest.current.find(m=>memberKey(m)===id);if(!member)continue;
      try{
        let {backend,server}=connection(member);
        let live:LiveConnection[]=[];
        if(!backend){
          live=await invoke<LiveConnection[]>("ssh_live_connections");
          const resolved=memberConnection(member,navigation.servers,live.map(s=>({
            backendId:s.sessionId,pane:{
              server:{id:s.serverId??s.sessionId,name:navigation.servers.find(v=>v.id===s.serverId)?.name??s.host,host:s.host,port:s.port,username:s.username,authMethod:"password"} as ServerEntry,
              tmux:s.tmux?{...s.tmux,name:""}:undefined,tmuxWorkdir:s.tmuxWorkdir,
            },
          })));
          backend=resolved.backend;server=resolved.server??server;
        }
        if(!server)throw new Error("未找到对应连接，请在成员管理里选择本机服务器");
        const target={id:member.tmux.id,created:member.tmux.created};
        if(!alive.current||version!==revision.current)break;
        const raw=backend
          ?await invoke<string>("team_ai_capture",{sessionId:backend,target,workdir:member.workdir})
          :await invoke<string>("team_ai_capture_saved",{serverId:server.id,target,workdir:member.workdir}).catch(e=>{throw new Error(`无法采集 ${server!.username}@${server!.host}:${server!.port}：${String(e)}。请在成员管理中核对连接地址和已保存的凭据。`);});
        const text=redactTerminal(raw);if(!text)throw new Error("没有可总结的输出");
        const source=sourceOf(member);
        const digest=await excerptDigest(JSON.stringify([config,source,text]));
        if(force||member.aiDigest!==digest||member.aiSource!==source)result.push({member,text,digest,source});
      }catch(e){errors[id]=String(e);}
    }
    if(alive.current&&version===revision.current)setIssues(old=>{const next={...old};for(const id of ids)delete next[id];return {...next,...errors};});
    return result;
  };
  const summarize=async(batch:Clip[],version:number,force=false)=>{
    let count=0;
    for(const clip of batch){
      if(!alive.current||version!==revision.current)break;
      const current=latest.current.find(m=>memberKey(m)===memberKey(clip.member));
      if(!current||sourceOf(current)!==clip.source)continue;
      const lease=JSON.parse(await collaborationRequest(sessionId,profile,{operation:"memberLease",body:owner.current}));
      if(lease.granted!==true)throw new LeaseBusyError(`已有总结任务正在运行，约 ${Math.min(180,Math.max(1,Number(lease.retryAfter)||180))} 秒后可重试；自动总结会继续重试。`);
      try{
      if(!alive.current||version!==revision.current)break;
      const roster:TeamMember[]=JSON.parse(await collaborationRequest(sessionId,profile,{operation:"members"})).map((m:unknown)=>parseMember(m,profile.project));
      const fresh=roster.find(m=>memberKey(m)===memberKey(clip.member));
      if(!alive.current||version!==revision.current)break;
      if(!fresh||sourceOf(fresh)!==clip.source||(!force&&fresh.aiDigest===clip.digest))continue;
      const summary=await invoke<{status:State;summary:string}>("team_ai_summarize",{endpointUrl:config.endpoint,profileId:config.id??null,protocol:protocolOf(config),model:config.model,excerpt:clip.text});
      if(!alive.current||version!==revision.current)break;
      await collaborationRequest(sessionId,profile,{operation:"memberNotes",body:JSON.stringify({project:profile.project,id:current.id,email:current.email,
        aiSummary:summary.summary,aiStatus:summary.status,aiUpdatedAt:new Date().toISOString(),aiDigest:clip.digest,aiSource:clip.source,aiEvidence:clip.text.slice(-1000)})});
      count++;
      await onUpdated();
      }finally{
        // Keep the lease until an in-flight model request settles, even after
        // unmount/cancellation. Release only our own lease on every exit path.
        await collaborationRequest(sessionId,profile,{operation:"memberLease",body:JSON.stringify({owner:owner.current,action:"release"})}).catch(()=>{});
      }
    }
    return count;
  };
  const perform=async(action:()=>Promise<void>,stopAutoOnError=true)=>{
    if(running.current)return;running.current=true;setBusy(true);setNotice("");
    try{await action();}catch(e){if(alive.current){setNotice(e instanceof Error?e.message:String(e));if(stopAutoOnError&&!(e instanceof LeaseBusyError))setAuto(false);}}
    finally{running.current=false;if(alive.current)setBusy(false);}
  };
  const summarizeMember=(member:TeamMember)=>void perform(async()=>{
    const version=revision.current;setSingleBusy(memberKey(member));
    try{
      const batch=await capture(version,[memberKey(member)],true);
      const count=await summarize(batch,version,true);
      if(alive.current&&version===revision.current)setNotice(count?`已更新 ${member.role}`:`${member.role} 未能更新，请展开查看详情。`);
    }finally{if(alive.current)setSingleBusy(undefined);}
  },false);
  const summarizeAll=()=>void perform(async()=>{
    const version=revision.current;
    const ids=members.map(memberKey);
    let count=0;
    try{
      for(let index=0;index<ids.length;index++){
        if(!alive.current||version!==revision.current)return;
        setBatchProgress(`总结中 ${index+1}/${ids.length}`);
        const batch=await capture(version,[ids[index]],true);
        try{count+=await summarize(batch,version,true);}
        catch(e){
          if(e instanceof LeaseBusyError)throw e;
          if(alive.current&&version===revision.current)setIssues(old=>({...old,[ids[index]]:e instanceof Error?e.message:String(e)}));
        }
      }
      if(alive.current&&version===revision.current)setNotice(`已更新 ${count}/${ids.length} 位 Worker${count<ids.length?"，未更新成员请展开查看详情。":"。"}`);
    }finally{if(alive.current)setBatchProgress("");}
  },false);
  const scope=JSON.stringify([config,selected.map(id=>{const m=members.find(m=>memberKey(m)===id);return m?[id,sourceOf(m)]:[id];})]);
  useEffect(()=>{revision.current++;setAuto(false);setConfirmAuto(false);},[scope]);
  const startAuto=()=>void perform(async()=>{
    const version=revision.current;setConfirmAuto(false);setConsent(scope);setAuto(true);
    const batch=await capture(version);const count=await summarize(batch,version);
    if(alive.current&&version===revision.current)setNotice(count?`已更新 ${count} 人`:"暂无新输出");
  });
  const tick=useRef<()=>void>(()=>{});
  tick.current=()=>void perform(async()=>{
    const version=revision.current;
    await onUpdated();
    const batch=await capture(version);
    const count=await summarize(batch,version);
    if(alive.current&&version===revision.current)setNotice(count?`已更新 ${count} 个摘要。`:"暂无新输出");
  });
  useEffect(()=>{
    if(!auto)return;
    const timer=window.setInterval(()=>{if(!document.hidden)tick.current();},60000);
    return()=>window.clearInterval(timer);
  },[auto]);
  const connectionKey=JSON.stringify(selected.map(id=>{const m=members.find(m=>memberKey(m)===id);return m?[id,connection(m).backend??""]:[id];}));
  const previousConnection=useRef(connectionKey);
  useEffect(()=>{
    const changed=previousConnection.current!==connectionKey;previousConnection.current=connectionKey;
    if(changed&&auto&&Object.keys(issues).length)tick.current();
  },[connectionKey,auto]);
  // Board offline / still loading: there are no count chips, so a leftover filter would trap the
  // list on "没有符合的成员" with no way to clear it. Drop the filter with the summary.
  const liveReady=!!snapshot;
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
    const {role,suffix}=names.get(key)!;
    const valid=!!(m.aiSource===sourceOf(m)&&m.aiSummary);
    const expired=valid&&!(Date.now()-Date.parse(m.aiUpdatedAt??"")<300000);
    const aiText=valid?`AI：${expired?"摘要已过期 · ":""}${m.aiSummary}`:"";
    const open=memberOpen(key);
    const {server}=connection(m);
    const brief=session?.taskCode?live.briefs[briefKey(session.project,session.taskCode)]:undefined;
    const now=snapshot?.now??Math.floor(Date.now()/1000);
    const identity=<strong className="team-ai-identity" title={`${m.role} · ${m.tmux.name}`}>{role}{suffix&&<span className="team-live-suffix"> · {suffix}</span>}</strong>;
    const actions=<span className="team-ai-row-actions">
      <Button size="icon-sm" variant="ghost" disabled={!server||busy} aria-label={`打开 · ${m.role} · ${m.tmux.name}`} title={server?"打开终端":"未找到对应连接"} onClick={e=>{e.preventDefault();e.stopPropagation();if(server)void perform(()=>navigation.onOpen(m,server));}}><ExternalLink size={14}/></Button>
      <Button className="team-ai-single" size="icon-sm" variant="ghost" aria-label={singleBusy===key?`总结中 · ${m.role}`:`总结 · ${m.role}`} aria-busy={singleBusy===key} title={`使用 ${configName(config)} 发送并总结此成员的终端输出`} disabled={busy||!config.endpoint||!config.model} onClick={e=>{e.preventDefault();e.stopPropagation();summarizeMember(m);}}>{singleBusy===key?<span className="team-ai-busy-text">总结中…</span>:<Sparkles size={14}/>}</Button>
    </span>;
    // 只有确实有上一张卡时才占一格；没有就不放空信息（同「无当前卡」不渲染的理由）。
    const rosterNote=!session&&m.currentTask?.trim()?m.currentTask.trim().split(/\r?\n/)[0]:"";
    const lastCard=session?.taskCode
      ?<span className="team-compact-card" title={`上一张卡 ${session.taskCode}${brief?.brief||brief?.title?` · ${brief.brief||brief.title}`:""}`}>{session.taskCode} ✓</span>
      :rosterNote?<span className="team-compact-card is-roster" title={m.currentTask}>{rosterNote}</span>:null;
    const details=<div className="team-card-expanded">
      {session&&<p className="team-live-detail">分支 {session.branch||"—"} · {session.commitHash||"—"}{session.lastLine&&<><br/>最后一行：{session.lastLine}</>}</p>}
      {(valid||issues[key])&&<p className="team-ai-summary">{issues[key]?"AI 总结采集失败":`AI：${expired?"摘要已过期 · ":""}${m.aiSummary}`}</p>}
      <p className="team-ai-note">AI 总结为推测，按需手动触发。更新时间：{valid&&m.aiUpdatedAt?new Date(m.aiUpdatedAt).toLocaleString():"暂无"}</p>
      {issues[key]&&<p role="alert" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{issues[key]}</p>}
      {valid&&m.aiEvidence&&<details><summary>上次成功采集的片段</summary><pre>{m.aiEvidence}</pre></details>}
      {open&&renderMemberAdmin?.(m)}
      <Button size="sm" aria-label={`打开终端 · ${m.role}`} disabled={!server||busy} onClick={()=>server&&void perform(()=>navigation.onOpen(m,server))}>打开终端</Button>
    </div>;
    if(compact){
      return <details className={`team-compact-row team-live-row${status.needsHuman?" team-live-alert":status.group==="waitLead"?" team-live-wait-lead":""}`} key={key} open={open} onToggle={e=>toggleMember(key,(e.currentTarget as HTMLDetailsElement).open)} data-state={session?.state??"none"} data-group={status.group}>
        <summary className="team-compact-head">
          <span className={`team-live-dot is-${status.tone}`} aria-hidden="true"/>
          {identity}
          <span className="team-compact-state"><span className={`team-live-badge is-${status.tone}`} title={status.title}>{status.label}</span>{status.duration&&<small>{status.duration}</small>}</span>
          {lastCard}
          {actions}
        </summary>
        {details}
      </details>;
    }
    return <details className={`team-ai-row team-live-row team-live-card${status.needsHuman?" team-live-alert":status.group==="waitLead"?" team-live-wait-lead":""}`} key={key} open={open} onToggle={e=>toggleMember(key,(e.currentTarget as HTMLDetailsElement).open)} data-state={session?.state??"none"} data-group={status.group}>
      <summary className="team-card-head">
        <span className={`team-live-dot is-${status.tone}`} aria-hidden="true"/>
        {identity}
        <span className="team-live-status"><span className={`team-live-badge is-${status.tone}`} title={status.title}>{status.label}</span>{status.duration&&<small>{status.duration}</small>}{valid&&session?.taskCode&&<span className="team-ai-chip" title={aiText}>AI</span>}</span>
        {actions}
        {session?.taskCode
          ?<div className="team-card-line2"><b>{session.taskCode}</b>{session.taskStatus&&<em>{live.statusNames[briefKey(session.project,session.taskStatus)]??session.taskStatus}</em>}{(brief?.brief||brief?.title)&&<span className="team-card-brief">{brief.brief||brief.title}</span>}</div>
          :!session&&m.currentTask?.trim()
            ?<div className="team-card-line2 is-roster" title={m.currentTask}><b>Lead 备注</b><span className="team-card-brief">{m.currentTask.trim().split(/\r?\n/)[0]}</span></div>
            :aiText
              ?<div className="team-card-line2 is-ai" title={aiText}><span className="team-ai-inline">{aiText}</span></div>
              :null}
        {(session?.commitTime||session?.model||session?.host||session?.dirty||(!session&&m.host))
          ?<div className="team-card-line3" title={[session?.commitHash,session?.branch].filter(Boolean).join(" · ")}>
            {session&&session.commitTime>0&&<span>提交 {ago(session.commitTime,now)}前 · {session.commitSubject}</span>}
            {session?.model&&<span>{session.model}</span>}
            <span>{session?.host||m.host}</span>
            {session&&session.dirty>0&&<span className="team-live-dirty">未提交 {session.dirty} 个文件</span>}
          </div>
          :null}
      </summary>
      {details}
    </details>;
  };
  return <section className="team-dynamics" aria-label="团队动态">
    <div className="team-toolbar">
      <div className="team-toolbar-title"><strong>团队 · {members.length} 人</strong><small>看板实时 · 每分钟刷新{auto?" · AI 自动总结中":""}</small></div>
      <TeamLiveSummary board={board} live={live} summary={summarizeTeam(ranked,snapshot)} filter={activeFilter} onFilter={toggleFilter}/>
      {activeFilter&&<Button size="sm" variant="ghost" onClick={()=>setFilter(undefined)}>清除筛选</Button>}
      <div className="team-toolbar-actions">
        <Button size="icon-sm" variant="ghost" aria-label="刷新成员" title="刷新成员" disabled={!!disabled||busy} onClick={()=>onRefresh?.()}><RefreshCw size={15}/></Button>
        <Button size="sm" disabled={!!disabled||busy} onClick={()=>onAddMember?.()}><Plus size={14}/> 添加成员</Button>
        <Button size="sm" variant="outline" disabled={busy||!members.length||!config.endpoint||!config.model} title={`使用 ${configName(config)} 发送并总结全部 ${members.length} 位 Worker 的终端输出`} onClick={summarizeAll}>{batchProgress||"总结全部"}</Button>
        {auto?<Button size="sm" variant="ghost" onClick={()=>{revision.current++;setAuto(false);setNotice("已暂停");}}>暂停</Button>:<Button size="sm" disabled={busy||!selected.length||!config.endpoint||!config.model} onClick={()=>consent===scope?startAuto():setConfirmAuto(true)}>开启自动总结</Button>}
        <details className="team-ai-options team-toolbar-details"><summary>设置与详情 · {selected.length} 人</summary>
          {!config.endpoint||!config.model?<p>先到「设置 → 云端摘要」配置供应商、模型和 API Key。</p>:<p>发送到：{config.endpoint} · {config.model}</p>}
          <p>每个成员读取当前活动窗格最近 80 行（最多 6000 字）。已过滤常见凭据，仍请检查代码和日志中的敏感内容。最多选择 10 人。</p>
          <div className="team-ai-selection">{members.map(m=><label key={memberKey(m)}><input type="checkbox" checked={selected.includes(memberKey(m))} disabled={busy||(!selected.includes(memberKey(m))&&selected.length>=10)} onChange={e=>{setSelection(e.target.checked?[...selected,memberKey(m)]:selected.filter(id=>id!==memberKey(m)));setAuto(false);setClips([]);setAllowAuto(false);}}/>{displayName(m,members).role}</label>)}</div>
          <Button size="sm" disabled={busy||!selected.length||!config.model||!config.endpoint} onClick={()=>void perform(async()=>{const version=revision.current;setAuto(false);setClips([]);const batch=await capture(version);if(alive.current&&version===revision.current){setClips(batch);setNotice(batch.length?`已准备 ${batch.length} 个片段，尚未发送。`:"无新输出可总结，请查看各成员的采集提示。");}})}>预览终端片段</Button>
          {!!clips.length&&<div className="team-ai-preview">
            {clips.map(c=><details key={memberKey(c.member)}><summary>{c.member.role} · {c.text.length} 字</summary><pre>{c.text}</pre></details>)}
            <label><input type="checkbox" checked={allowAuto} disabled={busy} onChange={e=>setAllowAuto(e.target.checked)}/>允许向上述接口每 60 秒自动发送所选成员的新输出（关闭面板后停止）</label>
            <Button size="sm" disabled={busy} onClick={()=>void perform(async()=>{const version=revision.current;const count=await summarize(clips,version);if(alive.current&&version===revision.current){setClips([]);if(allowAuto)setConsent(scope);setAuto(allowAuto);setNotice(`已更新 ${count} 个摘要。${allowAuto?"自动刷新已开启。":""}`);}})}>发送片段并总结</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={()=>setClips([])}>取消</Button>
          </div>}
        </details>
        {more&&<details className="team-ai-options team-toolbar-details"><summary>更多</summary><div className="team-more-body">{more}</div></details>}
      </div>
    </div>
    {confirmAuto&&<div className="team-ai-confirm">
      <p>向 <strong>{configName(config)}</strong> 发送 {selected.length} 位成员的终端输出，每分钟更新；关闭团队面板后停止。</p>
      <small>{config.endpoint} · {config.model}</small>
      <small>{members.filter(m=>selected.includes(memberKey(m))).map(m=>m.role).join("、")}。已过滤常见凭据，日志和代码仍可能包含敏感内容。</small>
      <div><Button size="sm" disabled={busy} onClick={startAuto}>确认开启</Button><Button size="sm" variant="ghost" onClick={()=>setConfirmAuto(false)}>取消</Button></div>
    </div>}
    {(busy||notice)&&<small role="status">{busy?"正在更新…":notice}</small>}
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
  </section>;
}
