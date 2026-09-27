import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { aiProviders, type AiProvider } from "../lib/aiStatus";
import {
  taskSnapshot,
  subscribeTasks,
  taskLabels,
  acknowledgeTasks,
  enableDesktopNotifications,
  type TaskStatus,
} from "../lib/taskStatus";
import { IconClose } from "./Icons";
export function useTasks() {
  const [tasks, setTasks] = useState(taskSnapshot);
  useEffect(() => subscribeTasks(() => setTasks(taskSnapshot())), []);
  return tasks;
}
export default function TasksPanel({
  onClose,
  onSelect,
  sessionId,
  serverName,
  statusError,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
  sessionId?: string;
  serverName?: string;
  statusError?: string;
}) {
  const tasks = useTasks();
  const [error, setError] = useState("");
  const [provider, setProvider] = useState<AiProvider>("claude");
  const [busy, setBusy] = useState(false);
  const setup = async (remove: boolean) => {
    if (!sessionId || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<{ message: string }>("ai_setup", { sessionId, provider, remove });
      setError(result.message);
      window.dispatchEvent(new Event("dssh-ai-refresh"));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <aside className="workspace-panel">
      <header data-panel-drag-handle tabIndex={0}>
        <strong>任务状态</strong>
        <Button variant="ghost" size="icon-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </Button>
      </header>
      <div className="workspace-actions">
        <Button variant="outline" size="sm" onClick={acknowledgeTasks}>
          全部已读
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void enableDesktopNotifications()
              .then(() => setError("已开启桌面提醒"))
              .catch((e) => setError(String(e)))
          }
        >
          开启桌面提醒
        </Button>
      </div>
      {error && <p role="status">{error}</p>}
      {statusError && <p role="alert">{statusError}</p>}
      <details className="workspace-hint">
        <summary>接入 AI 状态{serverName ? ` · ${serverName}` : ""}</summary>
        <p>在这台服务器为当前用户接入工具事件；保留已有 Hooks 并备份配置。接入后重启工具，Codex 可能需要在 /hooks 中审阅并信任。远端需 Python 3。</p>
        <div className="workspace-actions">
          <select aria-label="AI 工具" value={provider} disabled={busy} onChange={event => setProvider(event.target.value as AiProvider)}>
            {Object.entries(aiProviders).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <Button variant="outline" size="sm" disabled={!sessionId || busy} onClick={() => void setup(false)}>{busy ? "处理中…" : "接入"}</Button>
          <Button variant="outline" size="sm" disabled={!sessionId || busy} onClick={() => void setup(true)}>移除接入</Button>
        </div>
        <p>pi 支持开始、本轮结束、错误及新版 UI 等待事件；未提供事件的确认提示标为推测。已有普通 SSH 窗格需重新连接后启动工具，tmux 无需重建会话。</p>
      </details>
      <p className="workspace-hint">
        工具通知会直接提醒；根据终端文字判断的状态标为“推测”。安静不代表完成。
      </p>
      <div className="workspace-scroll">
        {tasks.length === 0 && <p>连接服务器后开始跟踪。</p>}
        {tasks.map((task) => {
          const quiet =
            task.phase === "running" && clock - task.updated > 15000;
          return (
            <Button
              variant="outline"
              size="sm"
              className="task-card"
              key={task.id}
              onClick={() => onSelect(task.id)}
            >
              <strong>
                {task.name}
                {task.unread ? " ●" : ""}
              </strong>
              {task.provider && <small>{aiProviders[task.provider]} · {task.estimated ? "终端推测" : "工具事件"}</small>}
              <Badge variant="secondary" className={"task-phase " + task.phase}>
                {quiet ? "暂时无输出" : taskLabels[task.phase]}
                {task.estimated ? " · 推测" : ""}
              </Badge>
              <small>
                {quiet ? "没有新的终端输出，任务可能仍在运行" : task.message}
              </small>
              <small>{new Date(task.updated).toLocaleTimeString()}</small>
            </Button>
          );
        })}
      </div>
    </aside>
  );
}
