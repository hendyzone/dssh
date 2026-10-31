import {teamProjectIssue} from "../lib/teamServiceProjects";
import { invoke } from "@tauri-apps/api/core";
import { refreshTeamService, useTeamService } from "../lib/teamService";
import TeamServiceBanner from "./TeamServiceBanner";
import { useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import { resolveWorktree, type CollaborationProfile, type CollaborationSession } from "../lib/collaboration";
import { loadTeamMappings, matchingServers, memberKey, memberMappingKey, memberNoteFields, parseMember, TEAM_MAPPING_KEY, type MemberNoteField, type TeamMember } from "../lib/teamMembers";
import { teamLeadPrompt } from "../lib/teamLeadPrompt";
import type { ServerEntry } from "../types";
import type { BoardSource } from "../lib/taskLookup";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import TeamMemberNotes from "./TeamMemberNotes";
import TeamDynamics from "./TeamDynamics";
import { liveSnapshot, useAgentSessions } from "../lib/agentSessions";
import { memberDisplay } from "../lib/memberDisplay";
import type { OfficeSnapshot } from "../lib/teamOffice";

export interface TeamNavigation {
  server: ServerEntry;
  servers: ServerEntry[];
  sessions?: CollaborationSession[];
  onOpen: (member: TeamMember, server: ServerEntry) => Promise<void>;
}

/**
 * Team panel shell: roster IO, add/update form, notes editor and the shared toolbar actions.
 * The list itself is the single merged view in TeamDynamics (no 「动态 / 成员」 tabs):
 * management operations live in each member's expandable details.
 */
export default function TeamMembers({ sessionId, profile, navigation, board, officeSnapshot, officeVisible=true, onPopOut, onRoomOpenChange, focusMember, onFocused, onOpenTaskDetail }: {
  sessionId: string; profile: CollaborationProfile; navigation: TeamNavigation;
  /** Read-only taskboard (the same source as the task lookup above) for live member status. */
  board?: BoardSource;
  /** Pixel room shared by the team panel and the collaboration panel. */
  officeSnapshot?: OfficeSnapshot; officeVisible?: boolean; onPopOut?: () => Promise<void>;
  onRoomOpenChange?: (open: boolean) => void;
  /** Member to locate in the list (opened from the status bar). */
  focusMember?: {key: string; seq: number}; onFocused?: () => void;
  onOpenTaskDetail?: (project: string, code: string) => void;
}) {
  const service = useTeamService();
  const projectIssue = teamProjectIssue(service, profile.project);
  const team = service.snapshots[profile.project];
  const members = team?.members ?? [];
  const serviceIdentity = JSON.stringify([service.url, profile.project]);
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
  const addRef = useRef<HTMLDivElement>(null);

  const [confirmation, setConfirmation] = useState<{members: TeamMember[]; patchKey?: string}>();
  const [noteDraft, setNoteDraft] = useState<Partial<Record<MemberNoteField,string>>>({});
  const leadPrompt = teamLeadPrompt(profile,navigation.server,service.url);
  // One collector poll feeds the merged list, so status and details read the same snapshot.
  const live = useAgentSessions(board, members);
  const snapshot = liveSnapshot(live);
  const pending = useRef(false);
  const generation = useRef(0);
  const choices = (navigation.sessions ?? []).filter(s=>s.pane.tmux && s.backendId);
  const candidate = choices.find(s=>s.pane.id===selected);
  const run = async (action: (isCurrent:()=>boolean) => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(""); setNotice("");
    const version = generation.current;
    try { await action(()=>version===generation.current); } catch (e) {
      if (version !== generation.current) return;
      const failure = e as {status?: number; code?: string};
      if (failure?.status === 412 && ["rev_mismatch", "if_match_required"].includes(failure.code ?? "")) {
        setConfirmation(undefined);
        try {
          const fresh = await refreshTeamService(profile.project);
          if (version !== generation.current) return;
          if (!fresh) throw new Error("团队快照不可用");
          const list = fresh.members;
          const freshNote = list.find(member => memberKey(member) === noteMember);
          if (freshNote) setNoteDraft(noteValues(freshNote));
          else setNoteMember(undefined);
          const freshEdit = editing && list.find(member => memberKey(member) === memberKey(editing));
          setEditing(freshEdit); setRole(freshEdit?.role ?? ""); setSelected("");
          if (position) {
            try {
              const old = JSON.parse(position);
              const inputs = Array.isArray(old) ? old : [old];
              const refreshed = inputs.map(input => list.find(member => memberKey(member) === memberKey(input))).filter(Boolean) as TeamMember[];
              setPosition(JSON.stringify((Array.isArray(old) ? refreshed.map(writableMember) : refreshed[0] && writableMember(refreshed[0])) ?? {}, null, 2));
            } catch { setPosition(""); }
          }
          setError("名单已被他人修改，已刷新，请确认后重试");
        } catch { if (version === generation.current) setError("名单已被他人修改，刷新失败，请刷新成员后重试"); }
      } else if (failure?.status === 409 && failure.code === "tmux_mismatch") {
        setError("会话已更替，请刷新成员并核对当前会话后重试");
      } else setError("团队服务操作失败，请检查连接、权限及输入后重试");
    }
    finally { if (version === generation.current) { pending.current = false; setBusy(false); } }
  };
  const noteValues = (member: TeamMember) => Object.fromEntries(
    Object.keys(memberNoteFields).filter(field => field !== "quota").map(field => [field, member[field as MemberNoteField] ?? ""]));
  const writableMember = (member: TeamMember) => {
    const {aiSummary, aiStatus, aiUpdatedAt, aiDigest, aiSource, aiEvidence, updatedAt, ...input} = member;
    return input;
  };
  const hasPositionChange = (member: TeamMember) => {
    const old = members.find(item => memberKey(item) === memberKey(member));
    return old && ["host", "port", "username", "workdir", "tmux"].some(field =>
      JSON.stringify(old[field as keyof TeamMember]) !== JSON.stringify(member[field as keyof TeamMember]));
  };
  const writeMembers = async (list: TeamMember[], patchKey?: string) => {
    const version = generation.current;
    if (patchKey) {
      const member = list[0];
      await invoke("team_service_member_patch", {project: profile.project, key: patchKey,
        patch: {role: member.role, host: member.host, port: member.port, username: member.username, workdir: member.workdir, tmux: member.tmux}, rev: member.rev ?? null});
    } else await invoke("team_service_members_put", {project: profile.project, members: list.map(writableMember)});
    if (version !== generation.current) return;
    setConfirmation(undefined); setAdding(false); setEditing(undefined);
    setNotice("写入已接受，等待团队服务同步。");
  };
  const prepareMembers = async (list: TeamMember[], patchKey?: string) => {
    list = list.map(member => ({...member, rev:member.rev ?? members.find(old => memberKey(old) === memberKey(member))?.rev}));
    if (list.some(hasPositionChange)) { setConfirmation({members: list, patchKey}); return; }
    await writeMembers(list, patchKey);
  };
  useEffect(() => {
    setMapping(loadTeamMappings()); setPosition(""); setError(""); setNotice(""); setAdding(false); setBusy(false);setNoteMember(undefined);setConfirmation(undefined);
    return () => { generation.current++; pending.current = false; };
  }, [serviceIdentity]);
  const disabled = busy || !service.url || service.status.state !== "online";
  // The list and empty state are about workers; the Lead has a compact entry.
  const workers = members.filter(m=>!/^lead\b/i.test(m.role.trim()));
  const startAdd = (member?:TeamMember) => {setAdding(true);setEditing(member);setRole(member?.role??"");setSelected("");setError("");};
  // 「更新终端 / 添加成员」表单出现时把它带到视野里，并把焦点放到第一个输入控件。
  useEffect(()=>{
    if(!adding)return;
    addRef.current?.scrollIntoView?.({block:"center", behavior:"smooth"});
    (addRef.current?.querySelector("select, input, textarea") as HTMLElement|undefined)?.focus?.();
  },[adding]);
  const setConnection = (member:TeamMember, id:string) => {
    try {
      const next = {...loadTeamMappings(), [memberMappingKey(member)]:id};
      localStorage.setItem(TEAM_MAPPING_KEY, JSON.stringify(next)); setMapping(next);
    } catch (e) {setError(`无法保存连接：${String(e)}`);}
  };
  const connectionSelect = (member:TeamMember, server?:ServerEntry) => <label className="collaboration-field">本机连接 · {memberDisplay(member).title}
    <select value={server?.id??""} disabled={busy} onChange={e=>setConnection(member,e.target.value)}>
      <option value="">选择对应服务器</option>{navigation.servers.map(s=><option value={s.id} key={s.id}>{s.name} · {s.username}@{s.host}:{s.port}</option>)}
    </select>
  </label>;
  const copyLeadPrompt = () => void run(async current=>{
    try {await navigator.clipboard.writeText(leadPrompt);} catch {throw new Error("复制失败，请展开“查看提示词”手动复制。");}
    if(current())setNotice("提示词已复制，请粘贴到 Lead 对话。执行完成后刷新成员。");
  });
  /** Member management, rendered inside each member's expandable details. */
  const renderMemberAdmin = (member:TeamMember) => {
    const matches=matchingServers(member,navigation.servers);
    const selectedServer=mapping[memberMappingKey(member)]??(matches.length===1?matches[0].id:"");
    const server=navigation.servers.find(s=>s.id===selectedServer);
    const key=memberKey(member);
    return <>
      <TeamMemberNotes member={member} nowMs={snapshot?snapshot.now*1000:undefined}/>
      {noteMember===key && <div className="team-card-extra team-member-notes">
        <div className="team-notes-editor">
          {(Object.entries(memberNoteFields).filter(([key])=>key!=="quota") as [MemberNoteField,string][]).map(([field,label])=><label className="collaboration-field" key={field}>{label}<textarea maxLength={2000} disabled={busy} value={noteDraft[field]??""} onChange={e=>setNoteDraft(old=>({...old,[field]:e.target.value}))}/></label>)}
          <div className="collaboration-actions"><Button size="sm" disabled={disabled} onClick={()=>void run(async current=>{
            await invoke("team_service_member_patch", {project:profile.project, key, patch:noteDraft, rev:null});
            if(current()){setNoteMember(undefined);setNotice("写入已接受，等待团队服务同步。");}
          })}>保存备注</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setNoteMember(undefined)}>取消备注编辑</Button></div>
        </div>
      </div>}
      <div className="team-card-extra team-manage team-manage-content">
        <p><strong>{memberDisplay(member).title}</strong>{memberDisplay(member).role ? ` · 角色：${memberDisplay(member).role}` : ""}</p>
        <p>{member.username}@{member.host}:{member.port}</p><p>{member.workdir}</p>{member.email&&<p>{member.email}</p>}
        <p>信息更新：{member.updatedAt?new Date(member.updatedAt).toLocaleString():"未知"}（不代表在线）</p>
        {server?connectionSelect(member,server):<><p>为这位成员选择本机的 SSH 连接。</p>{connectionSelect(member)}{!navigation.servers.length&&<p>请先在左侧添加服务器。</p>}</>}
        <div className="collaboration-actions"><Button size="sm" variant="ghost" disabled={disabled} aria-label={`编辑备注 · ${memberDisplay(member).title}`} onClick={()=>{
          setNoteMember(key);setNoteDraft(noteValues(member));
        }}>编辑备注</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={()=>startAdd(member)}>更新终端</Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={()=>void run(async current=>{
            await invoke("team_service_member_delete", {project:profile.project,key,tmux:`${member.tmux.id}:${member.tmux.created}`,rev:member.rev??null});
            if(current())setNotice("删除已接受，等待团队服务同步。");
          })}>从团队移除</Button></div>
      </div>
    </>;
  };
  const addForm = adding ? <div className="team-add" aria-label="添加成员表单" ref={addRef}>
    <strong>{editing ? `更新 ${memberDisplay(editing).title} 的终端` : "选择一个成员终端"}</strong>
    <label className="collaboration-field">成员终端<select value={selected} disabled={busy} onChange={e=>{
      setSelected(e.target.value); const next=choices.find(s=>s.pane.id===e.target.value); if(!editing)setRole(next?.pane.tmux?.name??"");
    }}><option value="">选择已打开的终端</option>{choices.map(s=><option key={s.pane.id} value={s.pane.id}>{s.pane.tmux?.name} · {s.pane.server.name}</option>)}</select></label>
    {!choices.length && <p>先从左侧连接成员的服务器，在 tmux 列表打开它的会话，然后回到这里添加。</p>}
    <label className="collaboration-field">成员名称<Input value={role} disabled={busy} onChange={e=>setRole(e.target.value)} placeholder="例如 后端开发"/></label>
    <div className="collaboration-actions"><Button size="sm" disabled={disabled || (!candidate && !editing) || !role.trim()} onClick={()=>void run(async current=>{
      if (!candidate && editing) {
        await invoke("team_service_member_patch", {project:profile.project,key:memberKey(editing),patch:{role:role.trim()},rev:null});
        if(current()){setAdding(false);setEditing(undefined);setNotice("写入已接受，等待团队服务同步。");}
        return;
      }
      if(!candidate?.pane.tmux)return;
      const {pane,backendId}=candidate;
      const workdir=await resolveWorktree(backendId,pane.tmux!);
      if(!current())return;
      const existing=editing??members.find(m=>m.host===pane.server.host && m.port===pane.server.port && m.username===pane.server.username && m.tmux.id===pane.tmux!.id && m.tmux.created===pane.tmux!.created);
      const member=parseMember({rev:existing?.rev,id:existing?.id??`member-${crypto.randomUUID()}`,email:existing?.email??"",role:role.trim(),project:profile.project,host:pane.server.host,port:pane.server.port,username:pane.server.username,workdir,tmux:pane.tmux},profile.project);
      if(current()) await prepareMembers([member], editing ? memberKey(editing) : undefined);
    })}>{editing?"更新终端":"加入团队"}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>setAdding(false)}>取消</Button></div>
    <p>服务器和工作目录会自动读取，不需要配置邮箱。</p>
  </div> : undefined;
  const more = <>
    <Button size="sm" disabled={busy} onClick={copyLeadPrompt}>复制给 Lead 的提示词</Button>
    <details className="team-lead-guide"><summary>查看提示词</summary><p>贴给 Lead 批量登记成员和维护备注，完成后刷新成员。</p><textarea aria-label="给 Lead 的团队管理提示词" readOnly value={leadPrompt}/></details>
    <details><summary>高级：导入或分享成员位置</summary>
      <p className="team-footnote">团队保存在团队服务，换电脑后配置同一服务与项目即可继续使用。</p>
      <p>需要从其他设备转移成员位置时使用。</p>
      <label className="collaboration-field">成员位置 JSON（单个或批量数组）<textarea value={position} onChange={e=>setPosition(e.target.value)} placeholder="粘贴已有的成员位置"/></label>
      <div className="collaboration-actions"><Button size="sm" disabled={disabled||!position} onClick={()=>void run(async current=>{
        const raw = JSON.parse(position);
        const input = Array.isArray(raw) ? raw : [raw];
        if (!input.length || input.length > 100) throw new Error("每批须为 1–100 人");
        const list = input.map(value => parseMember(value, profile.project));
        if(current()) await prepareMembers(list);
      })}>登记到当前团队</Button>
      <Button size="sm" disabled={busy||!position} onClick={()=>void run(async current=>{
        const raw = JSON.parse(position);
        const parsed = Array.isArray(raw) ? raw.map(value => writableMember(parseMember(value,profile.project))) : writableMember(parseMember(raw,profile.project));
        await navigator.clipboard.writeText(JSON.stringify(parsed,null,2));
        if(current())setNotice("成员位置已复制。");
      })}>复制位置</Button>
      <Button size="sm" variant="ghost" disabled={disabled} onClick={()=>void run(async()=>{
        const existing=members.find(m=>m.host===navigation.server.host&&m.port===navigation.server.port&&m.username===navigation.server.username&&m.tmux.id===profile.tmuxId&&m.tmux.created===profile.tmuxCreated);
        setPosition(JSON.stringify(parseMember({id:existing?.id??`member-${crypto.randomUUID()}`,email:existing?.email??"",project:profile.project,role:existing?.role??profile.tmuxName,host:navigation.server.host,port:navigation.server.port,username:navigation.server.username,workdir:profile.workdir,tmux:{id:profile.tmuxId,created:profile.tmuxCreated,name:profile.tmuxName}},profile.project),null,2));
      })}>生成当前会话位置</Button></div>
    </details>
  </>;
  return <section className="team-members" aria-label="团队成员">
    {error && <p role="alert" className="collaboration-error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">正在处理…</p>}
    <TeamServiceBanner project={team} status={service.status}/>
    {!service.url && <p role="status">请在协作设置中配置团队服务。</p>}
    {confirmation && <section role="dialog" aria-label="确认成员位置变更">
      <p>将修改以下成员的位置。请核对服务器、目录与 tmux 身份后再次确认。</p>
      <pre>{JSON.stringify(confirmation.members.map(({role,host,port,username,workdir,tmux})=>({role,host,port,username,workdir,tmux})),null,2)}</pre>
      <Button disabled={disabled} onClick={()=>void run(()=>writeMembers(confirmation.members,confirmation.patchKey))}>确认位置变更</Button>
      <Button disabled={busy} onClick={()=>setConfirmation(undefined)}>取消位置变更</Button>
    </section>}
    {projectIssue && <p role="alert">{projectIssue}</p>}
    {!projectIssue && <TeamDynamics key={serviceIdentity} sessionId={sessionId} profile={profile} navigation={navigation} members={members} serviceLive={team?.live??{}} serviceAi={team?.ai??{}} aiEnabled={service.status.ai_enabled} serviceIdentity={serviceIdentity} board={board} live={live} onUpdated={async()=>{}}
      pinnedKeys={[noteMember, editing?memberKey(editing):undefined].filter((key):key is string=>!!key)}
      officeSnapshot={officeSnapshot} officeVisible={officeVisible} onPopOut={onPopOut} onRoomOpenChange={onRoomOpenChange}
      focusMember={focusMember} onFocused={onFocused} onOpenTaskDetail={onOpenTaskDetail}
      onRefresh={()=>void run(async()=>{await refreshTeamService(profile.project);})} onAddMember={()=>startAdd()} disabled={disabled} more={more} addForm={addForm} renderMemberAdmin={renderMemberAdmin}/>}
    {!projectIssue && !workers.length && !busy && !adding && <div className="team-empty"><Users size={30}/><h4>把成员终端放在一起</h4><p>订阅项目的成员将由团队服务同步。</p></div>}
  </section>;
}
