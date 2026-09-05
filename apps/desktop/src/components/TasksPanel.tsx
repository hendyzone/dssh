import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { useEffect, useState } from "react";
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
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const tasks = useTasks();
  const [error, setError] = useState("");
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
