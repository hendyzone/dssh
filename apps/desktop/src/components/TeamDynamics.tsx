import {useEffect,useRef,useState} from "react";
import {invoke} from "@tauri-apps/api/core";
import {collaborationRequest,type CollaborationProfile} from "../lib/collaboration";
import {memberConnection,memberKey,parseMember,type TeamMember} from "../lib/teamMembers";
import {excerptDigest,loadTeamAi,redactTerminal,protocolOf,configName} from "../lib/teamAi";
import type {TeamNavigation} from "./TeamMembers";
import {Button} from "./ui/button";
import type {ServerEntry} from "../types";

type LiveConnection={sessionId:string;serverId?:string;host:string;port:number;username:string;tmux?:{id:string;created:number};tmuxWorkdir?:string};

const states={working:"工作中",waiting:"等待处理",idle:"空闲",unknown:"待确认"} as const;
type State=keyof typeof states;
type Clip={member:TeamMember;text:string;digest:string;source:string};
const sourceOf=(m:TeamMember)=>JSON.stringify([m.host,m.port,m.username,m.workdir,m.tmux.id,m.tmux.created]);
export default function TeamDynamics({sessionId,profile,navigation,members,onUpdated}:{sessionId:string;profile:CollaborationProfile;navigation:TeamNavigation;members:TeamMember[];onUpdated:()=>Promise<void>}){
  const [config,setConfig]=useState(loadTeamAi);
  const [selection,setSelection]=useState<string[]|null>(null);
  const selected=selection??members.slice(0,10).map(memberKey);
  const [confirmAuto,setConfirmAuto]=useState(false);
  const [consent,setConsent]=useState("");
  const [clips,setClips]=useState<Clip[]>([]);
  const [auto,setAuto]=useState(false);
  const [allowAuto,setAllowAuto]=useState(false);
  const [busy,setBusy]=useState(false);
  const [singleBusy,setSingleBusy]=useState<string>();
  const [notice,setNotice]=useState("");
  const [issues,setIssues]=useState<Record<string,string>>({});
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
        if(!backend)throw new Error(`服务器“${server.name}”尚无可用 SSH 连接：${server.username}@${server.host}:${server.port}\n成员会话：${member.tmux.id} · 创建时间 ${member.tmux.created} · ${member.workdir}\n后端在线连接 ${live.length} 个：\n${live.map(s=>`${s.username}@${s.host}:${s.port} · ${s.tmux?`${s.tmux.id} / ${s.tmux.created}`:"普通 SSH"}${s.tmuxWorkdir?` · ${s.tmuxWorkdir}`:""}`).join("\n")||"无"}\n请打开此成员终端后重试；地址不同可在成员管理中重新选择连接。`);
        const raw=await invoke<string>("team_ai_capture",{sessionId:backend,target:{id:member.tmux.id,created:member.tmux.created},workdir:member.workdir});
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
      if(lease.granted!==true)throw new Error("另一台设备正在采集此团队，请稍后重试（最多等待 3 分钟）。");
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
    }
    return count;
  };
  const perform=async(action:()=>Promise<void>,stopAutoOnError=true)=>{
    if(running.current)return;running.current=true;setBusy(true);setNotice("");
    try{await action();}catch(e){if(alive.current){setNotice(String(e));if(stopAutoOnError)setAuto(false);}}
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
  return <section className="team-dynamics" aria-label="团队动态">
    <div className="team-toolbar"><strong>团队动态 <small>{auto?"每分钟自动更新":"AI 摘要"}</small></strong>
      {auto?<Button size="sm" variant="ghost" onClick={()=>{revision.current++;setAuto(false);setNotice("已暂停");}}>暂停</Button>:<Button size="sm" disabled={busy||!selected.length||!config.endpoint||!config.model} onClick={()=>consent===scope?startAuto():setConfirmAuto(true)}>开启自动总结</Button>}
    </div>
    {(!config.endpoint||!config.model)&&<p>先到「设置 → 云端摘要」添加模型配置。</p>}
    {confirmAuto&&<div className="team-ai-confirm">
      <p>向 <strong>{configName(config)}</strong> 发送 {selected.length} 位成员的终端输出，每分钟更新；关闭团队面板后停止。</p>
      <small>{config.endpoint} · {config.model}</small>
      <small>{members.filter(m=>selected.includes(memberKey(m))).map(m=>m.role).join("、")}。已过滤常见凭据，日志和代码仍可能包含敏感内容。</small>
      <div><Button size="sm" disabled={busy} onClick={startAuto}>确认开启</Button><Button size="sm" variant="ghost" onClick={()=>setConfirmAuto(false)}>取消</Button></div>
    </div>}
    <details className="team-ai-options"><summary>设置与详情 · {selected.length} 人</summary>
      {!config.endpoint||!config.model?<p>先到「设置 → 云端摘要」配置供应商、模型和 API Key。</p>:<p>发送到：{config.endpoint} · {config.model}</p>}
      <p>每个成员读取当前活动窗格最近 80 行（最多 6000 字）。已过滤常见凭据，仍请检查代码和日志中的敏感内容。最多选择 10 人。</p>
      <div className="team-ai-selection">{members.map(m=><label key={memberKey(m)}><input type="checkbox" checked={selected.includes(memberKey(m))} disabled={busy||(!selected.includes(memberKey(m))&&selected.length>=10)} onChange={e=>{setSelection(e.target.checked?[...selected,memberKey(m)]:selected.filter(id=>id!==memberKey(m)));setAuto(false);setClips([]);setAllowAuto(false);}}/>{m.role}</label>)}</div>
      <Button size="sm" disabled={busy||!selected.length||!config.model||!config.endpoint} onClick={()=>void perform(async()=>{const version=revision.current;setAuto(false);setClips([]);const batch=await capture(version);if(alive.current&&version===revision.current){setClips(batch);setNotice(batch.length?`已准备 ${batch.length} 个片段，尚未发送。`:"无新输出可总结，请查看各成员的采集提示。");}})}>预览终端片段</Button>
      {!!clips.length&&<div className="team-ai-preview">
        {clips.map(c=><details key={memberKey(c.member)}><summary>{c.member.role} · {c.text.length} 字</summary><pre>{c.text}</pre></details>)}
        <label><input type="checkbox" checked={allowAuto} disabled={busy} onChange={e=>setAllowAuto(e.target.checked)}/>允许向上述接口每 60 秒自动发送所选成员的新输出（关闭面板后停止）</label>
        <Button size="sm" disabled={busy} onClick={()=>void perform(async()=>{const version=revision.current;const count=await summarize(clips,version);if(alive.current&&version===revision.current){setClips([]);if(allowAuto)setConsent(scope);setAuto(allowAuto);setNotice(`已更新 ${count} 个摘要。${allowAuto?"自动刷新已开启。":""}`);}})}>发送片段并总结</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={()=>setClips([])}>取消</Button>
      </div>}
    </details>
    {(busy||notice)&&<small role="status">{busy?"正在更新…":notice}</small>}
    {(Object.keys(states) as State[]).map(state=>{
      const group=members.filter(m=>{const valid=m.aiSource===sourceOf(m)&&m.aiSummary&&!issues[memberKey(m)]&&Date.now()-Date.parse(m.aiUpdatedAt??"")<300000;return (valid&&m.aiStatus&&m.aiStatus in states?m.aiStatus:"unknown")===state;});
      if(!group.length)return null;
      return <div key={state} className={`team-activity-${state}`}><div className="team-activity-heading"><strong>{states[state]}</strong><span>{group.length}</span></div>{group.map(m=>{
        const valid=m.aiSource===sourceOf(m)&&m.aiSummary;
        const expired=valid&&!(Date.now()-Date.parse(m.aiUpdatedAt??"")<300000);
        const {server}=connection(m);
        return <details className="team-ai-row" key={memberKey(m)}><summary><strong title={m.role}>{m.role}</strong><span>{issues[memberKey(m)]?"采集失败，待确认":valid?`${expired?"摘要已过期 · ":""}${m.aiSummary}`:"尚未总结"}</span><Button className="team-ai-single" size="sm" variant="ghost" aria-label={`总结 · ${m.role}`} title={`使用 ${configName(config)} 发送并总结此成员的终端输出`} disabled={busy||!config.endpoint||!config.model} onClick={e=>{e.preventDefault();e.stopPropagation();summarizeMember(m);}}>{singleBusy===memberKey(m)?"总结中…":"总结"}</Button></summary>
          <p>AI 推测，非实时状态。更新时间：{valid&&m.aiUpdatedAt?new Date(m.aiUpdatedAt).toLocaleString():"暂无"}</p>
          {issues[memberKey(m)]&&<p role="alert" style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{issues[memberKey(m)]}</p>}
          {valid&&m.aiEvidence&&<details><summary>上次成功采集的片段</summary><pre>{m.aiEvidence}</pre></details>}
          <Button size="sm" disabled={!server||busy} onClick={()=>server&&void perform(()=>navigation.onOpen(m,server))}>打开终端</Button>
        </details>;
      })}</div>;
    })}
  </section>;
}
