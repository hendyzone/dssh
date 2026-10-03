import { useEffect, useMemo, useRef, useState } from "react";
import { Lock, LockOpen, Search } from "lucide-react";
import {
  BoardError, listProjects, listStatuses, loadCard, lookupTask, NO_SOURCE, projectReasonLabel, saveLookupSettings, shortName, taskIndex,
  useLookupSettings, type BoardProject, type BoardSource, type BoardStatus, type LookupResult, type ProjectReason, type TaskIndex,
} from "../lib/taskLookup";
import TaskCard, { StatusBadge } from "./TaskCard";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import "./TaskLookup.css";

const errorText = (e: unknown) => e instanceof BoardError ? e.message : `看板不可达：${String(e)}`;
const errorKind = (e: unknown) => e instanceof BoardError ? e.kind : "unreachable";

/** Shared state for a lookup box and the card it shows; stale responses are dropped. */
export function useTaskLookup(source?: BoardSource) {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<{ message: string; kind: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const run = async (load: (s: BoardSource) => Promise<LookupResult>) => {
    const id = ++generation.current;
    if (!source) { setResult(null); setError({ message: NO_SOURCE, kind: "config" }); return; }
    setBusy(true); setError(null);
    try { const value = await load(source); if (id === generation.current) setResult(value); }
    catch (e) { if (id === generation.current) { setResult(null); setError({ message: errorText(e), kind: errorKind(e) }); } }
    finally { if (id === generation.current) setBusy(false); }
  };
  useEffect(() => () => { generation.current++; }, []);
  return {
    result, error, busy,
    lookup: (input: string, project?: string) => run(s => lookupTask(s, input, project)),
    open: (project: string, code: string) => run(async s => ({ kind: "task", card: await loadCard(s, project, code) })),
    clear: () => { generation.current++; setResult(null); setError(null); setBusy(false); },
  };
}

export function LookupOutcome({ state, source }: { state: ReturnType<typeof useTaskLookup>; source?: BoardSource }) {
  const { result, error, busy } = state;
  return <>
    {busy && <p role="status">正在查询看板…</p>}
    {error && <p role="alert" className={`collaboration-error task-lookup-error is-${error.kind}`}>{error.message}</p>}
    {result?.kind === "choices" && <div className="task-lookup-choices" aria-label="候选任务">
      <p>「{result.code}」匹配到 {result.choices.length} 个任务，请选择：</p>
      {result.choices.map(c => <button type="button" key={`${c.project}/${c.task.code}`} className="task-list-row" onClick={() => void state.open(c.project, c.task.code)}>
        <span className="tb-card-code">{c.task.code}</span><span className="task-list-title">{c.task.title}</span><span className="tb-card-project">{c.project}</span>
      </button>)}
    </div>}
    {result?.kind === "task" && source && <TaskCard card={result.card} source={source} onOpenCode={(p, c) => void state.open(p, c)}/>}
  </>;
}

/**
 * Task lookup for the team panel: pick and lock a project, type a code (prefix optional),
 * or 「项目 编号」 when unlocked; browse the project's tasks by status, assignee and title.
 */
export default function TaskLookup({ source, inferred }: { source?: BoardSource; inferred?: { project: string; reason: ProjectReason } }) {
  const settings = useLookupSettings();
  const locked = settings.lockedProject;
  const [selected, setSelected] = useState(inferred && inferred.reason !== "locked" ? inferred.project : "");
  const project = locked || selected;
  const [projects, setProjects] = useState<BoardProject[]>([]);
  const [projectsError, setProjectsError] = useState("");
  const [input, setInput] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const state = useTaskLookup(source);
  useEffect(() => {
    let live = true;
    setProjectsError("");
    if (!source) return;
    listProjects(source).then(value => { if (live) setProjects(value.filter(p => !p.archived || p.slug === project)); }).catch(e => { if (live) setProjectsError(errorText(e)); });
    return () => { live = false; };
  }, [source?.key]);
  const lockedName = projects.find(p => p.slug === locked)?.name;
  const submit = () => { if (input.trim()) void state.lookup(input, project || undefined); };
  const setLock = (value: string) => {
    try { saveLookupSettings({ lockedProject: value }); setSettingsError(""); if (!value) setSelected(locked); }
    catch (e) { setSettingsError(String(e)); }
  };
  return <section className="task-lookup" aria-label="任务查询">
    <div className="task-lookup-project">
      {locked ? <span className="task-lookup-locked" title="锁定后只需输入编号；终端编号识别也使用此项目">
        <Lock size={13}/><strong>{lockedName ?? locked}</strong>{lockedName && lockedName !== locked && <small>{locked}</small>}
      </span> : <select aria-label="查询项目" value={selected} onChange={e => setSelected(e.target.value)}>
        <option value="">全部项目（按编号精确查找）</option>
        {selected && !projects.some(p => p.slug === selected) && <option value={selected}>{selected}</option>}
        {projects.map(p => <option key={p.slug} value={p.slug}>{p.name === p.slug ? p.slug : `${p.name} · ${p.slug}`}</option>)}
      </select>}
      <Button size="sm" variant={locked ? "default" : "outline"} aria-pressed={!!locked} disabled={!locked && !selected}
        title={locked ? "解锁后可切换项目" : "锁定此项目：重启 dssh 后保持，终端编号识别优先使用"}
        onClick={() => setLock(locked ? "" : selected)}>{locked ? <><LockOpen size={13}/>解锁</> : <><Lock size={13}/>锁定</>}</Button>
    </div>
    {!locked && inferred && <p className="task-lookup-hint">当前终端项目：{inferred.project}（{projectReasonLabel[inferred.reason]}）</p>}
    <form className="task-lookup-form" onSubmit={e => { e.preventDefault(); submit(); }}>
      <Input aria-label="任务编号" value={input} placeholder={project ? `编号，如 T1090 或 1090` : "项目 编号，如 smart-table T1090；或只输编号"} onChange={e => setInput(e.target.value)}/>
      <Button size="sm" type="submit" disabled={!input.trim() || state.busy}><Search size={13}/>查询</Button>
    </form>
    {!source && <p role="status" className="task-lookup-hint">{NO_SOURCE}</p>}
    {source && <p className="task-lookup-hint">{source.label} · 只读</p>}
    {projectsError && <p role="alert" className="collaboration-error">{projectsError}</p>}
    {settingsError && <p role="alert" className="collaboration-error">{settingsError}</p>}
    <LookupOutcome state={state} source={source}/>
    {source && project && <TaskBrowser key={`${source.key}|${project}`} source={source} project={project} slugs={projects.map(p => p.slug)} onOpen={code => void state.open(project, code)}/>}
  </section>;
}

const LIST_LIMIT = 200;
/** Filterable list of one project's tasks; loaded only when expanded. */
export function TaskBrowser({ source, project, slugs, onOpen }: { source: BoardSource; project: string; slugs: string[]; onOpen: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState<TaskIndex>();
  const [statuses, setStatuses] = useState<BoardStatus[]>([]);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [assignee, setAssignee] = useState("");
  const [query, setQuery] = useState("");
  const load = (force = false) => {
    setError("");
    Promise.all([taskIndex(source, project, force), listStatuses(source, project).catch(() => [])])
      .then(([i, s]) => { setIndex(i); setStatuses(s); }).catch(e => setError(errorText(e)));
  };
  useEffect(() => { if (open && !index) load(); }, [open]);
  const names = useMemo(() => new Map((index?.tasks ?? []).map(t => [t.assignee, shortName(t.assignee, [project, ...slugs])])), [index, slugs]);
  const byKey = new Map(statuses.map(s => [s.key, s]));
  const order = new Map(statuses.map((s, i) => [s.key, i]));
  const needle = query.trim().toLowerCase();
  const filtered = (index?.tasks ?? []).filter(t => (!status || t.status_key === status) && (!assignee || (assignee === "-" ? !t.assignee.trim() : names.get(t.assignee) === assignee))
    && (!needle || t.title.toLowerCase().includes(needle) || t.code.toLowerCase().includes(needle)))
    .sort((a, b) => (order.get(a.status_key) ?? 99) - (order.get(b.status_key) ?? 99) || b.updated_at.localeCompare(a.updated_at));
  const people = [...new Set(names.values())].filter(Boolean).sort();
  return <details className="task-browser" open={open} onToggle={e => setOpen((e.target as HTMLDetailsElement).open)}>
    <summary>浏览 {project} 的任务{index ? `（${index.tasks.length}）` : ""}</summary>
    {error && <p role="alert" className="collaboration-error">{error}</p>}
    {open && !index && !error && <p role="status">正在读取任务列表…</p>}
    {index && <>
      <div className="task-browser-filters">
        <select aria-label="按状态筛选" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">全部状态</option>{statuses.map(s => <option key={s.key} value={s.key}>{s.name}</option>)}
        </select>
        <select aria-label="按负责人筛选" value={assignee} onChange={e => setAssignee(e.target.value)}>
          <option value="">全部负责人</option><option value="-">未指派</option>{people.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <Input aria-label="搜索标题" value={query} placeholder="搜索标题或编号" onChange={e => setQuery(e.target.value)}/>
        <Button size="sm" variant="ghost" onClick={() => load(true)}>刷新</Button>
      </div>
      <p className="task-lookup-hint">{filtered.length} 条{filtered.length > LIST_LIMIT ? `，显示前 ${LIST_LIMIT} 条` : ""}；列表每 5 分钟更新</p>
      <div className="task-list">{filtered.slice(0, LIST_LIMIT).map(t => <button type="button" key={t.code} className="task-list-row" title={t.title} onClick={() => onOpen(t.code)}>
        <span className="tb-card-code">{t.code}</span>
        <StatusBadge name={byKey.get(t.status_key)?.name ?? t.status_key} color={byKey.get(t.status_key)?.color}/>
        <span className="task-list-title">{t.title}</span>
        <span className="task-list-who">{names.get(t.assignee) || "未指派"}</span>
      </button>)}</div>
    </>}
  </details>;
}
