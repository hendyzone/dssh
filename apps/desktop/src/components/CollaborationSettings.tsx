import { useState } from "react";
import { collaborationKey, collaborationMailHome, emptyProfile, loadCollaboration, resolveWorktree, saveCollaboration, useCollaboration, type CollaborationSession, type CollaborationProfile } from "../lib/collaboration";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./Collaboration.css";

export default function CollaborationSettings({sessions=[]}: {sessions?:CollaborationSession[]}) {
  const choices=sessions.filter(s=>s.pane.tmux && s.backendId);
  const [paneId,setPaneId]=useState(choices[0]?.pane.id ?? "");
  const selected=choices.find(s=>s.pane.id===paneId);
  const stored=useCollaboration();
  const saved=Object.entries(stored).filter(([key,p])=>selected?.pane.tmux && key===collaborationKey(selected.pane.server.id,p) && p.tmuxId===selected.pane.tmux.id && p.tmuxCreated===selected.pane.tmux.created);
  const bound=(id:string)=>{
    const tmux=choices.find(s=>s.pane.id===id)?.pane.tmux;
    return {...emptyProfile(),tmuxId:tmux?.id??"",tmuxCreated:tmux?.created??0,tmuxName:tmux?.name??""};
  };
  const [profile,setProfile]=useState(()=>bound(paneId));
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const update=(patch:Partial<CollaborationProfile>)=>{setProfile(p=>({...p,...patch}));setMessage("");};
  const field=(key:keyof CollaborationProfile,label:string,placeholder:string)=>(
    <label className="collaboration-field" key={key}>{label}<Input value={String(profile[key])} placeholder={placeholder} onChange={e=>update({[key]:e.target.value})}/></label>
  );
  return <div className="collaboration-settings">
    <p>可选功能，默认关闭。每个 tmux 会话 + worktree 独立绑定项目和邮箱。</p>
    {!choices.length ? <p>请先连接并打开一个 tmux 会话，再配置它的 worktree 协作。</p> : <>
      <label className="collaboration-field">tmux 会话<select disabled={busy} value={paneId} onChange={e=>{setPaneId(e.target.value);setProfile(bound(e.target.value));setMessage("");}}>
        {choices.map(s=><option key={s.pane.id} value={s.pane.id}>{s.pane.server.name} · {s.pane.tmux?.name} ({s.pane.tmux?.id})</option>)}
      </select></label>
      {!!saved.length&&<label className="collaboration-field">此会话已保存的 worktree<select disabled={busy} value={selected&&stored[collaborationKey(selected.pane.server.id,profile)]?collaborationKey(selected.pane.server.id,profile):""} onChange={e=>{setProfile(stored[e.target.value]??bound(paneId));setMessage("");}}>
        <option value="">新建绑定</option>{saved.map(([key,p])=><option key={key} value={key}>{p.workdir} · {p.project || "未设置项目"} · {p.enabled?"已开启":"已关闭"}</option>)}
      </select></label>}
      <Button disabled={!selected||busy} onClick={async()=>{if(!selected?.pane.tmux)return;setBusy(true);try{const root=await resolveWorktree(selected.backendId,selected.pane.tmux);const p={...bound(paneId),workdir:root};setProfile(loadCollaboration()[collaborationKey(selected.pane.server.id,p)]??p);setMessage("已读取当前 worktree 及其协作配置。");}catch(e){setMessage(String(e));}finally{setBusy(false);}}}>读取当前 worktree 配置</Button>
      <label className="collaboration-toggle"><input type="checkbox" checked={profile.enabled} onChange={e=>update({enabled:e.target.checked})}/> 开启此会话 + worktree 的 Agent 协作</label>
      {field("project","项目编号","与看板和 amail 中的项目一致")}
      {field("workdir","worktree 根目录","/srv/workspace/my-project-worktree")}
      <p>目录必须是该 tmux 会话当前 Git worktree 的根目录。</p>
      <fieldset><legend><label className="collaboration-toggle"><input type="checkbox" checked={profile.taskboardEnabled} onChange={e=>update({taskboardEnabled:e.target.checked})}/> 任务看板</label></legend>
        {profile.taskboardEnabled&&<>
          {field("taskboardUrl","看板服务地址（从远端访问）","https://taskboard.example.com")}
          {field("taskboardBin","taskboard 命令或绝对路径","taskboard")}
          {field("tokenFile","远端令牌文件（可选）","/path/to/taskboard-token")}
        </>}
      </fieldset>
      <fieldset><legend><label className="collaboration-toggle"><input type="checkbox" checked={profile.mailEnabled} onChange={e=>update({mailEnabled:e.target.checked})}/> Agent 通信 · amail</label></legend>
        {profile.mailEnabled&&<>
          {field("pythonBin","远端 Python 命令","python3")}
          {field("mailctlPath","mailctl.py 远端路径","/srv/workspace/amail/client/mailctl.py")}
          <p>会话邮箱目录：{profile.workdir ? collaborationMailHome(profile) : "请先读取 worktree"}。在此目录通过 mailctl provision 建立 .agent-mail 身份；不同会话隔离，密码留在远端。</p>
        </>}
      </fieldset>
      <Button disabled={!selected||busy} onClick={()=>{try{saveCollaboration(selected!.pane.server.id,profile);setMessage(profile.enabled?"已保存并开启此会话 + worktree 的协作。":"已保存，Agent 协作保持关闭。");}catch(e){setMessage(String(e));}}}>保存协作配置</Button>
      {message&&<p role="status">{message}</p>}
      <p>关闭并保存后停止后续查询；已提交的操作可能仍在远端完成。配置仅保存在本机，不随连接备份自动开启。</p>
    </>}
  </div>;
}
