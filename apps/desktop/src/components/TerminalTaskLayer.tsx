import { useEffect, useState } from "react";
import { listProjects, listStatuses, shortName, type BoardSource, type BoardStatus, type IndexTask } from "../lib/taskLookup";
import { StatusBadge } from "./TaskCard";
import { LookupOutcome, useTaskLookup } from "./TaskLookup";
import { Button } from "./ui/button";
import { IconClose } from "./Icons";
import "./TaskLookup.css";

export interface TaskHover { task: IndexTask; x: number; y: number }

/** Hover card and the full card opened by clicking a task code in the terminal. */
export default function TerminalTaskLayer({ source, project, hover, opened, onClose }: {
  source: BoardSource; project: string; hover: TaskHover | null; opened: { code: string; seq: number } | null; onClose: () => void;
}) {
  const [statuses, setStatuses] = useState<BoardStatus[]>([]);
  const [slugs, setSlugs] = useState<string[]>([]);
  const lookup = useTaskLookup(source);
  useEffect(() => {
    let live = true;
    listStatuses(source, project).then(s => { if (live) setStatuses(s); }).catch(() => {});
    listProjects(source).then(p => { if (live) setSlugs(p.map(x => x.slug)); }).catch(() => {});
    return () => { live = false; };
  }, [source.key, project]);
  useEffect(() => { if (opened) void lookup.open(project, opened.code); else lookup.clear(); }, [opened?.seq]);
  useEffect(() => {
    if (!opened) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [!!opened]);
  const status = hover && statuses.find(s => s.key === hover.task.status_key);
  const who = hover ? shortName(hover.task.assignee, [project, ...slugs]) : "";
  return <>
    {hover && !opened && <div className="task-hover-card" role="tooltip" style={{ left: hover.x, top: hover.y }}>
      <div className="task-hover-head"><span className="tb-card-code">{hover.task.code}</span><StatusBadge name={status?.name ?? (hover.task.status_key || "未知状态")} color={status?.color}/><small>{who || "未指派"}</small></div>
      <div className="task-hover-title">{hover.task.title}</div>
      <small>点击查看完整卡片 · {project}</small>
    </div>}
    {opened && <div className="task-overlay" role="dialog" aria-label="任务详情">
      <header><strong>任务 · {project}</strong><Button variant="ghost" size="icon-sm" aria-label="关闭任务详情" onClick={onClose}><IconClose size={14}/></Button></header>
      <LookupOutcome state={lookup} source={source}/>
    </div>}
  </>;
}
