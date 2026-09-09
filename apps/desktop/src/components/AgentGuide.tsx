import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { agentGuide, type GuideMode } from "../lib/agentGuide";
import type { CollaborationProfile } from "../lib/collaboration";
import { Button } from "./ui/button";

export default function AgentGuide({profile}: {profile?:CollaborationProfile}) {
  const [mode,setMode]=useState<GuideMode>("existing");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  const [expanded,setExpanded]=useState(false);
  const content=agentGuide(mode,profile);
  const copy=async()=>{
    setBusy(true);setMessage("");
    try{await navigator.clipboard.writeText(content);setMessage("已复制完整手册和接入指令，粘贴给 agent 即可。");}
    catch{setExpanded(true);setMessage("剪贴板不可用，请从下方 Markdown 中全选复制。");}
    finally{setBusy(false);}
  };
  const save=async()=>{
    setBusy(true);setMessage("");
    try{const path=await invoke<string|null>("collaboration_export_guide",{content});setMessage(path?`已保存：${path}`:"已取消保存。");}
    catch(e){setMessage(`保存失败：${String(e)}`);}
    finally{setBusy(false);}
  };
  return <section className="agent-guide" aria-label="Agent 操作手册">
    <strong>发给 Agent 的操作手册</strong>
    <p>程序已内置完整 Markdown，离线可用。选择接入方式后复制给 agent，或保存为文件发送。</p>
    <label className="collaboration-field">接入方式<select disabled={busy} value={mode} onChange={e=>{setMode(e.target.value as GuideMode);setMessage("");}}>
      <option value="existing">Agent 已在 tmux 中运行</option><option value="new">新建 worktree 和 Agent</option>
    </select></label>
    <div className="collaboration-actions"><Button disabled={busy} onClick={()=>void copy()}>复制给 Agent</Button><Button variant="outline" disabled={busy} onClick={()=>void save()}>保存 Markdown</Button></div>
    {message&&<p role="status">{message}</p>}
    <details open={expanded} onToggle={e=>setExpanded(e.currentTarget.open)}><summary>查看将要发送的 Markdown</summary><textarea aria-label="Agent 手册 Markdown" readOnly value={content} rows={12}/></details>
  </section>;
}
