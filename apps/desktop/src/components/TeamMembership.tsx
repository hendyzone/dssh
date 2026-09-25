import { useEffect, useState, type ReactNode } from "react";
import { collaborationKey, collaborationRequest, emptyProfile, loadCollaboration, resolveWorktree, saveCollaboration, useCollaboration, type CollaborationProfile } from "../lib/collaboration";
import { loadTeamMappings, matchingServers, memberKey, memberMappingKey, parseMember, type TeamMember } from "../lib/teamMembers";
import TeamMemberNotes from "./TeamMemberNotes";
import type { SessionInfo } from "../types";
import type { TeamNavigation } from "./TeamMembers";
import { Button } from "./ui/button";

export default function TeamMembership({sessionId, pane, navigation, children, onPromoted}: {
  sessionId:string; pane:SessionInfo; navigation:TeamNavigation; children:ReactNode; onPromoted:(profile:CollaborationProfile)=>void;
}) {
  const profiles=useCollaboration();
  const [revision,setRevision]=useState(0);
  const [result,setResult]=useState<{key:string; teams:{member:TeamMember; lead:TeamMember}[]; incomplete:boolean}>();
  const [error,setError]=useState("");
  const [opening,setOpening]=useState(false);
  const [promotion,setPromotion]=useState<{member:TeamMember; profile:CollaborationProfile; count:number}>();
  const [promoting,setPromoting]=useState(false);
  const checkPromotion=async(member:TeamMember)=>{
    if(!pane.tmux||!sessionId)throw new Error("请先连接当前 tmux 会话。");
    const workdir=await resolveWorktree(sessionId,pane.tmux);
    const identity={tmuxId:pane.tmux.id,tmuxCreated:pane.tmux.created,workdir};
    const existing=loadCollaboration()[collaborationKey(pane.server.id,identity)];
    if(existing&&existing.project!==member.project)throw new Error(`当前工作区已绑定项目 ${existing.project}，请先解除原绑定。`);
    const next={...emptyProfile(),...existing,...identity,tmuxName:pane.tmux.name,project:member.project,enabled:true,membersEnabled:true};
    const raw:unknown=JSON.parse(await collaborationRequest(sessionId,next,{operation:"members"}));
    if(!Array.isArray(raw)||raw.length>100)throw new Error("当前工作区的团队名单格式无效。");
    const members=raw.map(m=>parseMember(m,member.project));
    if(!members.length)throw new Error("当前工作区没有团队名单。请先将原名单迁移到此工作区，再设为 Lead；不会创建空名单。");
    if(!members.some(m=>memberKey(m)===memberKey(member)&&m.tmux.id===pane.tmux!.id&&m.tmux.created===pane.tmux!.created&&m.workdir===workdir))throw new Error("新名单中当前成员的位置不匹配，请让 Lead 核对迁移结果。");
    return {member,profile:next,count:members.length};
  };
  const endpoints=navigation.servers;
  const sessions=[...(navigation.sessions??[]),{pane,backendId:sessionId}];
  const candidates=Object.entries(profiles).flatMap(([key,p])=>{
    if(!p.enabled)return [];
    const server=endpoints.find(s=>collaborationKey(s.id,p)===key);
    if(!server)return [];
    const connection=sessions.find(s=>s.backendId && s.pane.server.host.toLowerCase()===server.host.toLowerCase() && s.pane.server.port===server.port && s.pane.server.username===server.username);
    return [{profile:p,server,backendId:connection?.backendId}];
  });
  const key=JSON.stringify([sessionId,pane.server.host,pane.server.port,pane.server.username,pane.tmux,candidates,revision]);
  useEffect(()=>{
    let live=true;
    setError("");
    const discover=async()=>{
      if(!candidates.length || !pane.tmux || !sessionId){
        if(live)setResult({key,teams:[],incomplete:!!candidates.length});
        return;
      }
      try {
        const root=await resolveWorktree(sessionId,pane.tmux);
        const mappings=loadTeamMappings();
        const lists=await Promise.allSettled(candidates.map(async ({profile:p,server,backendId})=>{
          if(!backendId)throw new Error("Lead 服务器未连接");
          const raw:unknown=JSON.parse(await collaborationRequest(backendId,p,{operation:"members"}));
          if(!Array.isArray(raw)||raw.length>100)throw new Error("成员列表格式无效");
          const members=raw.map(m=>parseMember(m,p.project));
          const member=members.find(m=>(matchingServers(m,[pane.server]).length>0 || mappings[memberMappingKey(m)]===pane.server.id) && m.tmux.id===pane.tmux!.id && m.tmux.created===pane.tmux!.created && m.workdir===root);
          const lead:TeamMember={id:"member-lead",email:"",project:p.project,role:"Lead",host:server.host,port:server.port,username:server.username,workdir:p.workdir,tmux:{id:p.tmuxId,created:p.tmuxCreated,name:p.tmuxName}};
          return member?{member,lead}:undefined;
        }));
        if(live)setResult({key,teams:lists.flatMap(r=>r.status==="fulfilled"&&r.value?[r.value]:[]),incomplete:lists.some(r=>r.status==="rejected")});
      } catch(e){if(live){setError(String(e));setResult({key,teams:[],incomplete:true});}}
    };
    void discover();
    return ()=>{live=false;};
  },[key]);
  const current=result?.key===key?result:undefined;
  return <section className="team-members" aria-label="当前窗口的团队">
    {!current ? <p role="status">正在识别当前窗口的团队…</p> : <>
      <div className="team-toolbar"><strong>{current.teams.length?"当前窗口是团队成员":"当前窗口的团队"}</strong><Button size="sm" variant="ghost" onClick={()=>setRevision(v=>v+1)}>刷新团队</Button></div>
      {current.teams.map(({member,lead})=>{
        const server=matchingServers(lead,endpoints)[0];
        return <article className="team-card" key={JSON.stringify(lead)}>
          <div className="team-card-title"><strong>{member.project} · {member.role}</strong><p>Lead：{lead.tmux.name}</p></div>
          <Button size="sm" disabled={!server||opening} onClick={async()=>{
            if(!server)return;
            setOpening(true);setError("");
            try{await navigation.onOpen(lead,server);}catch(e){setError(String(e));}finally{setOpening(false);}
          }}>打开 Lead 终端</Button>
          <TeamMemberNotes member={member}/>
          <div className="team-card-extra"><Button size="sm" variant="outline" disabled={promoting||!sessionId} onClick={async()=>{
            setPromoting(true);setError("");setPromotion(undefined);
            try{setPromotion(await checkPromotion(member));}catch(e){setError(String(e));}finally{setPromoting(false);}
          }}>将当前窗口设为 Lead</Button></div>
        </article>;
      })}
      {promotion&&<div className="team-add" aria-label="确认 Lead 绑定">
        <strong>接管 {promotion.profile.project}</strong>
        <p>{pane.server.name} · {pane.tmux?.name}</p><p>{promotion.profile.workdir}</p>
        <p>此工作区已读取到 {promotion.count} 名成员。仅更改本机入口，不复制名单、不结束旧 Lead；其他设备需要同步新绑定。</p>
        <div className="collaboration-actions"><Button size="sm" disabled={promoting} onClick={async()=>{
          setPromoting(true);setError("");
          try{
            const checked=await checkPromotion(promotion.member);
            if(checked.profile.workdir!==promotion.profile.workdir)throw new Error("当前工作目录已变化，请重新检查后接管。");
            saveCollaboration(pane.server.id,checked.profile);onPromoted(checked.profile);
          }catch(e){setError(String(e));setPromotion(undefined);}finally{setPromoting(false);}
        }}>确认设为 Lead</Button><Button size="sm" variant="ghost" disabled={promoting} onClick={()=>setPromotion(undefined)}>取消</Button></div>
      </div>}
      {current.incomplete && <p role="status">部分团队尚未确认，请连接 Lead 所在服务器后刷新。</p>}
      {!current.teams.length && <>
        <p>尚未识别到所属团队。如果这是成员窗口，请先打开已有 Lead 的团队，再回来刷新。</p>
        <details><summary>将当前窗口设为 Lead</summary>{children}</details>
      </>}
    </>}
    {error&&<p role="alert" className="collaboration-error">{error}</p>}
  </section>;
}
