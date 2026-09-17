import { useState } from "react";
import { Users } from "lucide-react";
import { collaborationKey, emptyProfile, loadCollaboration, resolveWorktree, saveCollaboration, type CollaborationProfile } from "../lib/collaboration";
import type { SessionInfo } from "../types";
import TeamMembers, { type TeamNavigation } from "./TeamMembers";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { IconClose } from "./Icons";
import "./Collaboration.css";

export default function TeamPanel({sessionId, pane, profile, navigation, onClose}: {
  sessionId: string; pane: SessionInfo; profile?: CollaborationProfile; navigation: TeamNavigation; onClose: () => void;
}) {
  const [created, setCreated] = useState<CollaborationProfile>();
  const [project, setProject] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = profile ?? created;
  return <aside className="workspace-panel collaboration-panel">
    <header data-panel-drag-handle tabIndex={0}><strong>团队{active ? ` · ${active.project}` : ""}</strong><Button variant="ghost" size="icon-sm" aria-label="关闭团队" onClick={onClose}><IconClose/></Button></header>
    <div className="collaboration-content">
      {active ? <TeamMembers sessionId={sessionId} profile={active} navigation={navigation}/> : <div className="team-setup">
        <Users size={32}/><h3>从这里打开团队成员的终端</h3>
        <p>在 Lead 窗口输入项目名称，再选择要加入的终端。另一台电脑连接同一个 Lead 工作区，也能看到成员。</p>
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
            saveCollaboration(pane.server.id, next); setCreated(next);
          } catch (e) {setError(String(e));} finally {setBusy(false);}
        }}>{busy ? "正在打开团队…" : "打开此项目的团队"}</Button>
        <p>只需远端 Python 3，无需先配置看板或邮箱。</p>
        {error && <p role="alert" className="collaboration-error">{error}</p>}
      </div>}
    </div>
  </aside>;
}
