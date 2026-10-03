import { useState } from "react";
import type { CollaborationSession } from "../lib/collaboration";
import {
  boardSource, boardUrlError, clearBoardCache, isIdentifier, listProjects, saveLookupSettings, serverOverrideKey, tmuxOverrideKey, useLookupSettings,
} from "../lib/taskLookup";
import type { ServerEntry } from "../types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./Collaboration.css";

export default function TaskLookupSettings({ sessions = [], servers = [] }: { sessions?: CollaborationSession[]; servers?: ServerEntry[] }) {
  const settings = useLookupSettings();
  const [url, setUrl] = useState(settings.boardUrl);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const choices = sessions.filter((s, i, all) => all.findIndex(o => o.pane.id === s.pane.id) === i);
  const [paneId, setPaneId] = useState(choices[0]?.pane.id ?? "");
  const pane = choices.find(s => s.pane.id === paneId)?.pane;
  const [scope, setScope] = useState<"tmux" | "server">(pane?.tmux ? "tmux" : "server");
  const [project, setProject] = useState("");
  const save = (patch: Parameters<typeof saveLookupSettings>[0], done: string) => {
    try { saveLookupSettings(patch); clearBoardCache(); setMessage(done); } catch (e) { setMessage(String(e)); }
  };
  const serverName = (id: string) => servers.find(s => s.id === id)?.name ?? sessions.find(s => s.pane.server.id === id)?.pane.server.name ?? id;
  const describe = (key: string) => {
    const [kind, serverId, ...rest] = key.split(":");
    return kind === "tmux" ? `${serverName(serverId)} · tmux ${rest.join(":")}` : `${serverName(serverId)}（整台服务器）`;
  };
  return <div className="collaboration-settings">
    <p>只读查询 taskboard：在团队面板输入任务编号查看状态卡片，终端里出现的真实编号可悬停查看、点击打开。dssh 不修改任何任务。</p>
    <fieldset><legend>看板地址</legend>
      <label className="collaboration-field">本机可访问的看板地址<Input value={url} placeholder="http://taskboard.example:8091" onChange={e => { setUrl(e.target.value); setMessage(""); }}/></label>
      <p>留空时，已在「Agent 协作」开启任务看板的 tmux 会话改为经该 SSH 服务器访问其中填写的地址。两条路不会互相兜底，查询结果会标明走的哪一条。</p>
      <div className="collaboration-actions">
        <Button size="sm" disabled={busy || !!boardUrlError(url)} onClick={() => save({ boardUrl: url }, url.trim() ? "已保存看板地址。" : "已清空看板地址。")}>保存地址</Button>
        <Button size="sm" variant="outline" disabled={busy || !url.trim() || !!boardUrlError(url)} onClick={async () => {
          const source = boardSource({ ...settings, boardUrl: url });
          if (!source) return;
          setBusy(true);
          try { clearBoardCache(); const projects = await listProjects(source, true); setMessage(`连接成功：${projects.length} 个项目。`); }
          catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
          finally { setBusy(false); }
        }}>测试连接</Button>
      </div>
      {boardUrlError(url) && <p role="alert" className="collaboration-error">{boardUrlError(url)}</p>}
    </fieldset>
    <label className="collaboration-toggle"><input type="checkbox" checked={settings.terminalLinks} onChange={e => save({ terminalLinks: e.target.checked }, e.target.checked ? "已开启终端编号识别。" : "已关闭终端编号识别。")}/> 识别终端中的任务编号（只认当前项目看板上存在的编号）</label>
    <fieldset><legend>当前项目</legend>
      <p>终端所属项目依次取：团队面板锁定的项目 → 此 tmux 会话的 Agent 协作绑定 → 下方手动指定（tmux 会话优先于服务器）。都没有时不识别编号。</p>
      {settings.lockedProject ? <div className="collaboration-actions"><span>已锁定：<strong>{settings.lockedProject}</strong></span><Button size="sm" variant="outline" onClick={() => save({ lockedProject: "" }, "已解锁项目。")}>解锁</Button></div> : <p>未锁定项目；可在团队面板顶部锁定。</p>}
      {choices.length ? <>
        <label className="collaboration-field">为会话指定项目<select value={paneId} onChange={e => { setPaneId(e.target.value); setScope(choices.find(s => s.pane.id === e.target.value)?.pane.tmux ? "tmux" : "server"); }}>
          {choices.map(s => <option key={s.pane.id} value={s.pane.id}>{s.pane.server.name}{s.pane.tmux ? ` · tmux ${s.pane.tmux.name}` : ""}</option>)}
        </select></label>
        <label className="collaboration-field">作用范围<select value={scope} onChange={e => setScope(e.target.value as "tmux" | "server")}>
          {pane?.tmux && <option value="tmux">此 tmux 会话（按会话名）</option>}
          <option value="server">整台服务器</option>
        </select></label>
        <label className="collaboration-field">项目编号<Input value={project} placeholder="例如 smart-table" onChange={e => setProject(e.target.value)}/></label>
        <Button size="sm" disabled={!pane || !isIdentifier(project.trim())} onClick={() => {
          if (!pane) return;
          const key = scope === "tmux" && pane.tmux ? tmuxOverrideKey(pane.server.id, pane.tmux.name) : serverOverrideKey(pane.server.id);
          save({ overrides: { ...settings.overrides, [key]: project.trim() } }, `已指定 ${describe(key)} → ${project.trim()}。`);
        }}>保存指定</Button>
      </> : <p>打开终端后可为其会话或服务器指定项目。</p>}
      {Object.entries(settings.overrides).map(([key, value]) => <div key={key} className="collaboration-actions"><span>{describe(key)} → <strong>{value}</strong></span>
        <Button size="sm" variant="ghost" onClick={() => { const next = { ...settings.overrides }; delete next[key]; save({ overrides: next }, "已移除指定。"); }}>移除</Button></div>)}
    </fieldset>
    {message && <p role="status">{message}</p>}
  </div>;
}
