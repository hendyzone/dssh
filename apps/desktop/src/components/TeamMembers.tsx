import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw, Terminal, Users } from "lucide-react";
import { collaborationRequest, resolveWorktree, type CollaborationProfile, type CollaborationSession } from "../lib/collaboration";
import { loadTeamMappings, matchingServers, memberKey, memberMappingKey, memberNoteFields, parseMember, TEAM_MAPPING_KEY, type MemberNoteField, type TeamMember } from "../lib/teamMembers";
import { teamLeadPrompt } from "../lib/teamLeadPrompt";
import type { ServerEntry } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import TeamMemberNotes from "./TeamMemberNotes";
import TeamDynamics from "./TeamDynamics";
import { memberActivity, memberActivityLabels, type MemberActivity } from "../lib/teamMembers";

export interface TeamNavigation {
  server: ServerEntry;
  servers: ServerEntry[];
  sessions?: CollaborationSession[];
  onOpen: (member: TeamMember, server: ServerEntry) => Promise<void>;
}

export default function TeamMembers({ sessionId, profile, navigation }: {
  sessionId: string; profile: CollaborationProfile; navigation: TeamNavigation;
}) {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState("");
  const [role, setRole] = useState("");
  const [position, setPosition] = useState("");
  const [editing, setEditing] = useState<TeamMember>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [mapping, setMapping] = useState(loadTeamMappings);
  const [noteMember, setNoteMember] = useState<string>();
  const [managedMember, setManagedMember] = useState<string>();

  const [noteDraft, setNoteDraft] = useState<Partial<Record<MemberNoteField,string>>>({});
  const leadPrompt = teamLeadPrompt(profile,navigation.server);
  const pending = useRef(false);
  const generation = useRef(0);
  const choices = (navigation.sessions ?? []).filter(s=>s.pane.tmux && s.backendId);
  const candidate = choices.find(s=>s.pane.id===selected);
  const run = async (action: (isCurrent:()=>boolean) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    const version = generation.current;
    try { await action(()=>version===generation.current); } catch (e) { if (version === generation.current) setError(String(e)); }
    finally { if (version === generation.current) { pending.current = false; setBusy(false); } }
  };
  const request = async (operation: "members" | "memberSave" | "memberRemove" | "memberNotes", body = "") => {
    const version = generation.current;
    const raw: unknown = JSON.parse(await collaborationRequest(sessionId, profile, {operation, body}));
    if (!Array.isArray(raw) || raw.length > 100) throw new Error("成员列表格式无效");
    const list = raw.map(m => parseMember(m, profile.project));
    if (version === generation.current) setMembers(list);
  };
  useEffect(() => {
    setMembers([]); setMapping(loadTeamMappings()); setPosition(""); setError(""); setNotice(""); setAdding(false); setBusy(false);setNoteMember(undefined);
    if (sessionId && profile.enabled) void run(() => request("members"));
    return () => { generation.current++; pending.current = false; };
  }, [sessionId, profile]);
  const disabled = busy || !sessionId || !profile.enabled;
  const startAdd = (member?:TeamMember) => {setAdding(true);setEditing(member);setRole(member?.role??"");setSelected("");setError("");};
  const setConnection = (member:TeamMember, id:string) => {
    try {
      const next = {...loadTeamMappings(), [memberMappingKey(member)]:id};
      localStorage.setItem(TEAM_MAPPING_KEY, JSON.stringify(next)); setMapping(next);
    } catch (e) {setError(`无法保存连接：${String(e)}`);}
  };
  const connectionSelect = (member:TeamMember, server?:ServerEntry) => <label className="collaboration-field">本机连接 · {member.role}
    <select value={server?.id??""} disabled={busy} onChange={e=>setConnection(member,e.target.value)}>
      <option value="">选择对应服务器</option>{navigation.servers.map(s=><option value={s.id} key={s.id}>{s.name} · {s.username}@{s.host}:{s.port}</option>)}
    </select>
  </label>;
  return <section className="team-members" aria-label="团队成员">
    <div className="team-toolbar"><strong>成员 {members.length > 0 && <span className="team-count">{members.length}</span>}</strong><div className="collaboration-actions">
      <Button size="icon-sm" variant="ghost" aria-label="刷新成员" disabled={disabled} onClick={()=>void run(()=>request("members"))}><RefreshCw size={15}/></Button>
      <Button size="sm" disabled={disabled} onClick={()=>startAdd()}><Plus size={14}/> 添加成员</Button>
    </div></div>
    <TeamDynamics key={JSON.stringify([sessionId,profile.project,profile.workdir])} sessionId={sessionId} profile={profile} navigation={navigation} members={members} onUpdated={()=>request("members")}/>
    <div className="team-lead-guide">
      <Button size="sm" disabled={busy} onClick={()=>void run(async current=>{
        try {await navigator.clipboard.writeText(leadPrompt);} catch {throw new Error("复制失败，请展开“查看提示词”手动复制。");}
        if(current())setNotice("提示词已复制，请粘贴到 Lead 对话。执行完成后刷新成员。");
      })}>复制给 Lead 的提示词</Button>
      <details><summary>查看提示词</summary><p>贴给 Lead 批量登记成员和维护备注，完成后刷新成员。</p><textarea aria-label="给 Lead 的团队管理提示词" readOnly value={leadPrompt}/></details>
    </div>
    {error && <p role="alert" className="collaboration-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">正在处理…</p>}
    {!sessionId && <p role="status">连接 Lead 终端后即可读取团队。</p>}
    {!members.length && !busy && !adding && <div className="team-empty"><Users size={30}/><h4>把成员终端放在一起</h4><p>点击「添加成员」，从已打开的终端中选择。成员可以在不同服务器上。</p></div>}
    {adding && <div className="team-add" aria-label="添加成员表单">
      <strong>{editing ? `更新 ${editing.role} 的终端` : "选择一个成员终端"}</strong>
      <label className="collaboration-field">成员终端<select value={selected} disabled={busy} onChange={e=>{
        setSelected(e.target.value); const next=choices.find(s=>s.pane.id===e.target.value); if(!editing)setRole(next?.pane.tmux?.name??"");
      }}><option value="">选择已打开的终端</option>{choices.map(s=><option key={s.pane.id} value={s.pane.id}>{s.pane.tmux?.name} · {s.pane.server.name}</option>)}</select></label>
      {!choices.length && <p>先从左侧连接成员的服务器，在 tmux 列表打开它的会话，然后回到这里添加。</p>}
      <label className="collaboration-field">成员名称<Input value={role} disabled={busy} onChange={e=>setRole(e.target.value)} placeholder="例如 后端开发"/></label>
      <div className="collaboration-actions"><Button size="sm" disabled={disabled || !candidate || !role.trim()} onClick={()=>void run(async current=>{
        if(!candidate?.pane.tmux)return;
        const {pane,backendId}=candidate;
        const workdir=await resolveWorktree(backendId,pane.tmux!);
        if(!current())return;
        const existing=editing??members.find(m=>m.host===pane.server.host && m.port===pane.server.port && m.username===pane.server.username && m.tmux.id===pane.tmux!.id && m.tmux.created===pane.tmux!.created);
        const member=parseMember({id:existing?.id??`member-${crypto.randomUUID()}`,email:existing?.email??"",role:role.trim(),project:profile.project,host:pane.server.host,port:pane.server.port,username:pane.server.username,workdir,tmux:pane.tmux},profile.project);
        await request("memberSave",JSON.stringify(member));
        if(current()){setAdding(false);setEditing(undefined);setNotice(`${member.role} 已加入团队，可以直接打开终端。`);}
      })}>{editing?"更新终端":"加入团队"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setAdding(false)}>取消</Button></div>
      <p>服务器和工作目录会自动读取，不需要配置邮箱。</p>
    </div>}
    {(["working","idle","unknown"] as MemberActivity[]).map(activity=>{
      const group=members.filter(member=>memberActivity(member)===activity);
      if(!group.length)return null;
      return <section className={`team-activity-group team-activity-${activity}`} key={activity} aria-label={`${memberActivityLabels[activity]}成员`}>
        <div className="team-activity-heading" title="按 Lead 的当前任务备注分类，不代表实时在线状态"><strong>{memberActivityLabels[activity]}</strong><span>{group.length}</span></div>
        {group.map(member=>{
      const matches=matchingServers(member,navigation.servers);
      const selectedServer=mapping[memberMappingKey(member)]??(matches.length===1?matches[0].id:"");
      const server=navigation.servers.find(s=>s.id===selectedServer);
      return <article key={memberKey(member)} className="team-card">
        <div className="team-card-main"><span className="team-avatar"><Terminal size={15}/></span><div className="team-card-title"><strong title={member.role}>{member.role}</strong><p title={`${server?.name??member.host} · ${member.tmux.name}`}><span className={`team-activity-badge team-activity-${activity}`}>{memberActivityLabels[activity]}</span> {server?.name??member.host}{member.tmux.name!==member.role ? ` · ${member.tmux.name}` : ""}</p></div></div>
        <div className="team-card-actions"><Button className="team-open" size="sm" disabled={disabled||!server} aria-label={`打开终端 · ${member.role}`} onClick={()=>server&&void run(()=>navigation.onOpen(member,server))}>打开</Button><Button size="sm" variant="ghost" aria-expanded={managedMember===memberKey(member)} onClick={()=>setManagedMember(old=>old===memberKey(member)?undefined:memberKey(member))}>管理</Button></div>
        <TeamMemberNotes member={member}/>
        {noteMember===memberKey(member) && <div className="team-card-extra team-member-notes">
          {noteMember===memberKey(member) ? <div className="team-notes-editor">
            {(Object.entries(memberNoteFields).filter(([key])=>key!=="quota") as [MemberNoteField,string][]).map(([key,label])=><label className="collaboration-field" key={key}>{label}<textarea maxLength={2000} disabled={busy} value={noteDraft[key]??""} onChange={e=>setNoteDraft(old=>({...old,[key]:e.target.value}))}/></label>)}
            <div className="collaboration-actions"><Button size="sm" disabled={disabled} onClick={()=>void run(async current=>{
              await request("memberNotes",JSON.stringify({project:profile.project,id:member.id,email:member.email,...noteDraft}));
              if(current()){setNoteMember(undefined);setNotice("成员备注已保存。");}
            })}>保存备注</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setNoteMember(undefined)}>取消备注编辑</Button></div>
          </div>:null}
        </div>}
        {!server && <div className="team-card-extra"><p>为这位成员选择本机的 SSH 连接。</p>{connectionSelect(member)}{!navigation.servers.length&&<p>请先在左侧添加服务器。</p>}</div>}
        {managedMember===memberKey(member) && <div className="team-card-extra team-manage team-manage-content">
          <p>{member.username}@{member.host}:{member.port}</p><p>{member.workdir}</p>{member.email&&<p>{member.email}</p>}
          <p>信息更新：{member.updatedAt?new Date(member.updatedAt).toLocaleString():"未知"}（不代表在线）</p>
          {server&&connectionSelect(member,server)}
          <div className="collaboration-actions"><Button size="sm" variant="ghost" disabled={disabled} aria-label={`编辑备注 · ${member.role}`} onClick={()=>{
            setNoteMember(memberKey(member));setNoteDraft(Object.fromEntries(Object.keys(memberNoteFields).filter(key=>key!=="quota").map(key=>[key,member[key as MemberNoteField]??""])));
          }}>编辑备注</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={()=>startAdd(member)}>更新终端</Button>
            <Button size="sm" variant="ghost" disabled={disabled} onClick={()=>void run(()=>request("memberRemove",memberKey(member)))}>从团队移除</Button></div>
        </div>}
      </article>;
        })}
      </section>;
    })}
    <details><summary>高级：导入或分享成员位置</summary>
      <p className="team-footnote">团队保存在 Lead 工作区，换电脑后连接同一工作区即可继续使用。</p>
      <p>需要从其他设备转移成员位置时使用。</p>
      <label className="collaboration-field">成员位置 JSON<textarea value={position} onChange={e=>setPosition(e.target.value)} placeholder="粘贴已有的成员位置"/></label>
      <div className="collaboration-actions"><Button size="sm" disabled={disabled||!position} onClick={()=>void run(async current=>{
        await request("memberSave",JSON.stringify(parseMember(JSON.parse(position),profile.project)));
        if(current())setNotice("成员位置已保存。");
      })}>登记到当前团队</Button>
      <Button size="sm" disabled={busy||!position} onClick={()=>void run(async current=>{
        await navigator.clipboard.writeText(JSON.stringify(parseMember(JSON.parse(position),profile.project),null,2));
        if(current())setNotice("成员位置已复制。");
      })}>复制位置</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={()=>void run(async()=>{
        const existing=members.find(m=>m.host===navigation.server.host&&m.port===navigation.server.port&&m.username===navigation.server.username&&m.tmux.id===profile.tmuxId&&m.tmux.created===profile.tmuxCreated);
        setPosition(JSON.stringify(parseMember({id:existing?.id??`member-${crypto.randomUUID()}`,email:existing?.email??"",project:profile.project,role:existing?.role??profile.tmuxName,host:navigation.server.host,port:navigation.server.port,username:navigation.server.username,workdir:profile.workdir,tmux:{id:profile.tmuxId,created:profile.tmuxCreated,name:profile.tmuxName}},profile.project),null,2));
      })}>生成当前会话位置</Button></div>
    </details>
  </section>;
}
