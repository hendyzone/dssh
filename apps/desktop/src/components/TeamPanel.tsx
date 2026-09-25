import { useEffect, useState } from "react";
import { Users } from "lucide-react";
import { collaborationKey, collaborationRequest, emptyProfile, loadCollaboration, removeCollaboration, resolveWorktree, saveCollaboration, type CollaborationProfile } from "../lib/collaboration";
import {loadTeamMappings,memberMappingKey,parseMember,TEAM_MAPPING_KEY} from "../lib/teamMembers";
import type { SessionInfo } from "../types";
import TeamMembers, { type TeamNavigation } from "./TeamMembers";
import TeamMembership from "./TeamMembership";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { IconClose } from "./Icons";
import "./Collaboration.css";

const DETACHED="dssh.team-detached.v1";
function detachedBindings():string[]{
  try{const value=JSON.parse(localStorage.getItem(DETACHED)??"[]");return Array.isArray(value)?value.filter(v=>typeof v==="string"):[];}catch{return [];}
}

export default function TeamPanel({sessionId, pane, profile, navigation, onClose}: {
  sessionId: string; pane: SessionInfo; profile?: CollaborationProfile; navigation: TeamNavigation; onClose: () => void;
}) {
  const [created, setCreated] = useState<CollaborationProfile>();
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unbound, setUnbound] = useState(false);
  const active = unbound ? undefined : created ?? profile;
  const [recovering,setRecovering]=useState(false);
  const [recoveryRevision,setRecoveryRevision]=useState(0);
  const [choices,setChoices]=useState<CollaborationProfile[]>([]);
  useEffect(()=>{
    let live=true;
    if(active||unbound||!sessionId||!pane.tmux)return;
    // A different IP changes the local connection ID, not the existing remote roster.
    // Restore only the team entry; never inherit another connection's mail or task settings.
    const detached=detachedBindings();
    const candidates=Object.values(loadCollaboration()).filter(p=>p.enabled&&p.tmuxId===pane.tmux!.id&&p.tmuxCreated===pane.tmux!.created&&!detached.includes(collaborationKey(pane.server.id,p)));
    if(!candidates.length)return;
    setRecovering(true);setChoices([]);
    void (async()=>{
      const root=await resolveWorktree(sessionId,pane.tmux!);
      const matches=Array.from(new Map(candidates.filter(p=>p.workdir===root).map(p=>[p.project,p])).values());
      const found=await Promise.allSettled(matches.map(async p=>{
        const next={...emptyProfile(),enabled:true,membersEnabled:true,project:p.project,workdir:root,tmuxId:pane.tmux!.id,tmuxCreated:pane.tmux!.created,tmuxName:pane.tmux!.name};
        const raw:unknown=JSON.parse(await collaborationRequest(sessionId,next,{operation:"members"}));
        if(!Array.isArray(raw)||raw.length>100)throw new Error("成员列表格式无效");
        const members=raw.map(m=>parseMember(m,p.project));
        const current=members.find(m=>m.tmux.id===next.tmuxId&&m.tmux.created===next.tmuxCreated&&m.workdir===root);
        if(!current)return undefined;
        return {profile:next,member:current};
      }));
      if(!live)return;
      const verified=found.flatMap(r=>r.status==="fulfilled"&&r.value?[r.value]:[]);
      if(verified.length===1){
        const match=verified[0];
        // This mapping is scoped to this roster member, not a guessed global host alias.
        localStorage.setItem(TEAM_MAPPING_KEY,JSON.stringify({...loadTeamMappings(),[memberMappingKey(match.member)]:pane.server.id}));
        saveCollaboration(pane.server.id,match.profile);setCreated(match.profile);setError("");
      }else if(verified.length>1){setChoices(verified.map(v=>v.profile));}
    })().catch(e=>{if(live)setError(`核验当前工作区团队失败：${String(e)}`);}).finally(()=>{if(live)setRecovering(false);});
    return()=>{live=false;};
  },[sessionId,pane.server.id,pane.tmux?.id,pane.tmux?.created,!!active,unbound,recoveryRevision]);
  return <aside className="workspace-panel collaboration-panel">
    <header data-panel-drag-handle tabIndex={0}><strong>团队{active ? ` · ${active.project}` : ""}</strong><Button variant="ghost" size="icon-sm" aria-label="关闭团队" onClick={onClose}><IconClose/></Button></header>
    <div className="collaboration-content">
      {active ? <>
        <div className="team-binding">
          <div><p title={`${pane.server.name} · ${active.tmuxName || active.tmuxId}`}>{pane.server.name} · {active.tmuxName || active.tmuxId}</p></div>
          <Button size="sm" variant="outline" title="解除本机此窗口的项目绑定；不停止 Agent 或删除远端团队" onClick={()=>{
            try {
              localStorage.setItem(DETACHED,JSON.stringify([...new Set([...detachedBindings(),collaborationKey(pane.server.id,active)])]));
              removeCollaboration(pane.server.id, active);
              setCreated(undefined); setUnbound(true); setProject(""); setError("");
            } catch(e) {setError(String(e));}
          }}>退出团队</Button>
        </div>
        {error && <p role="alert" className="collaboration-error">{error}</p>}
        <TeamMembers sessionId={sessionId} profile={active} navigation={navigation}/>
      </> : recovering?<p role="status">正在核验当前工作区的已有团队…</p>:choices.length?<div><p>当前工作区存在多个团队，请选择：</p>{choices.map(next=><Button key={next.project} onClick={()=>{try{saveCollaboration(pane.server.id,next);setCreated(next);}catch(e){setError(String(e));}}}>{next.project}</Button>)}</div>:<><Button size="sm" variant="ghost" onClick={()=>setRecoveryRevision(v=>v+1)}>重新识别当前工作区</Button><TeamMembership sessionId={sessionId} pane={pane} navigation={navigation} onPromoted={next=>{setCreated(next);setUnbound(false);setError("");}}><div className="team-setup">
        {unbound && <p role="status">已退出团队。请切换到正确的 Lead 窗口后设置团队。</p>}
        <Users size={32}/><h3>从这里打开团队成员的终端</h3>
        <p>在 Lead 窗口输入项目名称，再选择要加入的终端。另一台电脑连接同一个 Lead 工作区，也能看到成员。</p>
        <p>当前窗口：{pane.server.name} · {pane.tmux?.name}</p>
        <label className="collaboration-field">项目名称<Input value={project} placeholder="例如 dssh" disabled={busy} onChange={e=>setProject(e.target.value)}/></label>
        <Button disabled={busy || !sessionId || !pane.tmux || !project.trim()} onClick={async()=>{
          if (!pane.tmux) return;
          setBusy(true);setError("");
          try {
            const workdir = await resolveWorktree(sessionId, pane.tmux);
            const identity = {tmuxId:pane.tmux.id, tmuxCreated:pane.tmux.created, workdir};
            const existing = loadCollaboration()[collaborationKey(pane.server.id, identity)];
            if (existing?.project && existing.project !== project.trim()) throw new Error(`此工作区已绑定项目 ${existing.project}，请使用该项目名称。`);
            const next = {...emptyProfile(), ...existing, ...identity, tmuxName:pane.tmux.name, project:project.trim(), membersEnabled:true, enabled:true};
            saveCollaboration(pane.server.id, next);localStorage.setItem(DETACHED,JSON.stringify(detachedBindings().filter(key=>key!==collaborationKey(pane.server.id,next)))); setCreated(next); setUnbound(false);
          } catch (e) {setError(String(e));} finally {setBusy(false);}
        }}>{busy ? "正在打开团队…" : "打开此项目的团队"}</Button>
        <p>只需远端 Python 3，无需先配置看板或邮箱。</p>
        {error && <p role="alert" className="collaboration-error">{error}</p>}
      </div></TeamMembership></>}
    </div>
  </aside>;
}
