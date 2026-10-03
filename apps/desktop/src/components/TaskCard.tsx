import { useState } from "react";
import { boardLink, formatAge, openBoard, shortName, type BoardSource, type TaskCardData } from "../lib/taskLookup";
import { Button } from "./ui/button";
import "./TaskLookup.css";

export function StatusBadge({ name, color }: { name: string; color?: string }) {
  return <span className="tb-status" style={color ? { ["--tb-status-color" as string]: color } : undefined}>{name}</span>;
}

/** Full card of one task. Read-only; dependencies open the next card in place. */
export default function TaskCard({ card, source, onOpenCode, now = Date.now() }: {
  card: TaskCardData; source: BoardSource; onOpenCode?: (project: string, code: string) => void; now?: number;
}) {
  const { task, status, project } = card;
  const [openError, setOpenError] = useState("");
  const who = shortName(task.assignee, [project, ...card.slugs]);
  const blocked = task.status_key === "blocked";
  return <article className={`tb-card${blocked ? " is-blocked" : ""}`} aria-label={`任务 ${task.code}`}>
    <header className="tb-card-head">
      <strong className="tb-card-code">{task.code}</strong>
      <StatusBadge name={status?.name ?? (task.status_key || "未知状态")} color={status?.color}/>
      <span className="tb-card-project">{project}</span>
    </header>
    <h4 className="tb-card-title">{task.title || "（无标题）"}</h4>
    <dl className="tb-card-meta">
      <dt>负责人</dt><dd title={task.assignee || undefined}>{who || "未指派"}</dd>
      <dt>在此列</dt><dd title={task.status_changed_at}>{formatAge(task.status_changed_at, now)}</dd>
      <dt>上次更新</dt><dd title={task.updated_at}>{formatAge(task.updated_at, now)}前</dd>
    </dl>
    {(task.blocked_reason || blocked) && <p className={`tb-card-blocked${blocked ? " is-active" : ""}`} role={blocked ? "alert" : undefined}>
      <strong>阻塞原因</strong>{task.blocked_reason || "未填阻塞原因"}
    </p>}
    {task.summary && <p className="tb-card-summary"><strong>摘要</strong>{task.summary}</p>}
    {task.acceptance && <p className="tb-card-acceptance"><strong>验收结论</strong>{task.acceptance}</p>}
    {card.dependencies.length > 0 && <div className="tb-card-deps">
      <strong>前置依赖</strong>
      <ul>{card.dependencies.map(dep => <li key={dep.code}>
        <button type="button" className="tb-card-dep" title={dep.title} onClick={() => onOpenCode?.(project, dep.code)}>
          <span className="tb-card-code">{dep.code}</span>
          <StatusBadge name={dep.status?.name ?? (dep.completed ? "已完成" : dep.status_key || "未完成")} color={dep.status?.color}/>
          <span className="tb-card-dep-title">{dep.title}</span>
        </button>
      </li>)}</ul>
    </div>}
    {task.detail && <details className="tb-card-detail"><summary>详细记录</summary><pre>{task.detail}</pre></details>}
    <footer className="tb-card-foot">
      <Button size="sm" variant="outline" title={boardLink(source, project, task.code)} onClick={() => { setOpenError(""); openBoard(boardLink(source, project, task.code)).catch(e => setOpenError(String(e))); }}>在看板中打开</Button>
    </footer>
    {openError && <p role="alert" className="collaboration-error">{openError}</p>}
  </article>;
}
