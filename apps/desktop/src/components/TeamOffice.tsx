import TeamServiceAi from "./TeamServiceAi";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "./ui/button";
import OfficeMail, {officeStationAnchor} from "./OfficeMail";
import TeamMemberAvatar from "./TeamMemberAvatar";
import { officeStatusCounts, type OfficeMember, type OfficeService, type OfficeSnapshot } from "../lib/teamOffice";
import "./TeamOffice.css";

const FOLLOW_KEY = "dssh.office.follow.v1";
function readFollow() {
  try { return localStorage.getItem(FOLLOW_KEY) !== "false"; } catch { return true; }
}
const SCALE_KEY = "dssh.office.scale.v1";
type OfficeScale = number;
type ScaleMode = "auto" | "1" | "2" | "3";
const textScale = (scale: number) => 1 + (scale - 1) * .15;
export function fitOfficeGrid(count: number, width: number, height: number, lead = false, groupCounts?: number[], tempZones = 0) {
  const total = Math.max(1, count);
  const factor = lead ? 1.12 : 1;
  const geometry = (scale: number, columns: number) => {
    const text = textScale(scale);
    const rows = groupCounts?.length ? groupCounts.reduce((sum, count) => sum + Math.ceil(count / columns), 0) : Math.ceil(total / columns);
    const stationWidth = Math.max(160, 96 * scale * factor);
    // Bubble, desk and label: name/status plus one or two task lines, padding and border.
    const stationHeight = 24 * text + 72 * scale * factor + (scale < 1.75 ? 52 : 70) * text;
    // Temporary zone headings are part of the grid: small rooms must fit them too.
    const tempHeight = tempZones > 0 ? tempZones * (24 * text + 6) : 0;
    return {scale, columns, rows, stationWidth, stationHeight,
      width: columns * stationWidth + (columns - 1) * 14,
      height: rows * stationHeight + (rows - 1) * 22 + tempHeight};
  };
  let best = geometry(1, Math.max(1, Math.min(total, Math.floor((width + 14) / 174))));
  for (let scale = 1; scale <= 3; scale += .25) {
    for (let columns = 1; columns <= total; columns++) {
      const candidate = geometry(scale, columns);
      if (candidate.width <= width && candidate.height <= height &&
          (candidate.scale > best.scale || candidate.scale === best.scale && candidate.rows < best.rows)) best = candidate;
    }
  }
  return best;
}
function readScale(): ScaleMode {
  try {
    const value = localStorage.getItem(SCALE_KEY);
    if (value === "1" || value === "2" || value === "3") return value;
  } catch { /* storage is optional */ }
  return "auto";
}
const COLLAPSE_KEY = "dssh.office.collapsed.v1";
const TOOL_LABELS: Record<string, string> = { claude: "CL", codex: "CX", pi: "PI", dsh: "DSH", cursor: "CU", agy: "AGY" };
const STATE_LABELS: Record<string, string> = { working: "运行中", idle: "空闲", blocked: "等待", error: "卡住", unknown: "离线", done: "完成" };

function priority(member: OfficeMember) {
  const counts = officeStatusCounts([member]);
  return counts.stuck ? 0 : counts.waiting ? 1 : counts.running ? 2 : counts.idle ? 3 : 4;
}
function sortedMembers(members: OfficeMember[]) {
  // 常驻工位要稳定：优先级相同的成员按稳定的调色板键排序，成员数组顺序变化不换位。
  return [...members].sort((a, b) => Number(b.isLead) - Number(a.isLead) || priority(a) - priority(b) || a.paletteKey.localeCompare(b.paletteKey));
}
function readCollapsed(projects: string[]): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? "null");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : projects.slice(1));
  } catch { return new Set(projects.slice(1)); }
}
function writeCollapsed(value: Set<string>) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...value])); } catch { /* storage is optional */ }
}
function skyPhase(date: Date) {
  const hour = date.getHours();
  if (hour >= 7 && hour < 18) return "day";
  if (hour >= 18 && hour < 21) return "dusk";
  return "night";
}
function clockText(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
function relative(seconds: number | undefined, now: number) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const minutes = Math.max(0, Math.round((now - seconds) / 60));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.floor(minutes / 60)} 小时前`;
}
function duration(seconds: number | undefined, now: number) {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(now - seconds / 1000));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分钟`;
  return `${Math.floor(total / 3600)} 小时 ${Math.floor((total % 3600) / 60)} 分`;
}
function serviceNote(service: OfficeService | undefined) {
  if (!service) return "数据来自团队服务的订阅项目。";
  if (service.state === "online") return "数据来自团队服务的订阅项目 · 服务在线";
  if (service.state === "connecting") return "数据来自团队服务的订阅项目 · 正在连接团队服务…";
  if (service.state === "unauthorized") return "团队服务令牌已失效：请在「设置 → 团队服务」重新配置令牌";
  if (service.state === "error") return "团队服务暂不可用：请检查团队服务配置";
  const at = service.at ? new Date(service.at) : undefined;
  return `团队服务离线 · 数据截至 ${at ? clockText(at) : "未知时间"}`;
}
function mailNote(mail: OfficeSnapshot["mail"], availability: string) {
  if (availability === "loading" || mail?.availability === "loading") return "正在连接邮件动态…";
  if (availability === "error" || mail?.availability === "error") return "邮件动态暂时失败，稍后自动重试";
  if (mail?.availability === "ready") return "显示已绑定邮箱收到的信";
  return "邮件动态未配置：在「设置 → Agent 协作」为本会话开启邮箱后显示";
}

/** Original pixel furniture, shared by occupied stations and the unassigned desks. */
function Desk({scale, lead = false}: {scale:number;lead?:boolean}) {
  return <svg className="office-furniture" width={96*scale} height={72*scale} viewBox="0 0 96 72" shapeRendering="crispEdges" aria-hidden="true">
    <path className="office-floor-shadow" d="M7 59h79v3h4v3H11v-3H7z"/>
    <path className="office-chair" d="M24 31h20v18H24zm5 18h10v9H29zm-5 9h20v3H24z"/>
    <path className="office-desk-leg" d="M10 42h5v18h-5zm70 0h5v18h-5z"/>
    <path className="office-desk-front" d="M8 38h80v9H8z"/>
    <path className="office-desk-top" d="M12 34h72v2h4v4H8v-4h4z"/>
    <path className="office-desk-highlight" d="M12 34h72v2H12z"/>
    <path className="office-monitor-frame" d="M52 13h29v20H52zm12 20h5v3h-5zm-5 3h15v2H59z"/>
    <path className="office-monitor-screen" d="M55 16h23v14H55z"/>
    <g className="office-screen-code office-motion"><path d="M58 19h8v2h-8zm0 4h14v1H58zm0 3h5v1h-5z"/><path className="office-screen-cursor" d="M66 26h3v1h-3z"/></g>
    <path className="office-paper" d="M57 39h13v2H57z"/>
    <path className="office-mug" d="M76 34h5v5h-5zm5 1h2v3h-2z"/>
    {lead && <><path className="office-lead-plaque" d="M10 43h13v5H10z"/><path className="office-plaque-mark" d="M13 44h7v2h-7z"/></>}
  </svg>;
}
function EmptyDesks({scale}: {scale:number}) {
  return <div className="office-empty-desks" aria-hidden="true">{[0,1,2].map(index=><div className="office-empty-desk office-pixels" aria-hidden="true" key={index} style={{width:96*scale,height:72*scale}}><Desk scale={scale}/></div>)}</div>;
}
function UpperWall({phase, clock}: {phase:"day"|"dusk"|"night"; clock:string}) {
  return <div className="office-upper-wall" data-phase={phase} aria-hidden="true">
    <svg width="640" height="112" viewBox="0 0 320 56" shapeRendering="crispEdges">
      <path className="office-window-frame" d="M20 8h63v37H20zm132 0h63v37h-63z"/>
      <path className="office-window-sky" d="M24 12h55v29H24zm132 0h55v29h-55z"/>
      <path className="office-cloud" d="M28 18h12v-3h10v3h8v4H28zm132 5h12v-3h13v3h9v4h-34z"/>
      {phase === "night" && <g className="office-stars office-motion"><path d="M30 15h2v2h-2zm20 6h2v2h-2zm12-8h2v2h-2zm20 14h2v2h-2zm52-12h2v2h-2zm18 12h2v2h-2zm22-8h2v2h-2zm16 14h2v2h-2z"/></g>}
      <path className="office-window-frame" d="M50 10h3v33h-3zm132 0h3v33h-3zM20 27h63v3H20zm132 0h63v3h-63z"/>
      <path className="office-window-sill" d="M17 43h69v4H17zm132 0h69v4h-69z"/>
      <path className="office-clock-rim" d="M108 11h18v3h3v18h-3v3h-18v-3h-3V14h3z"/>
      <path className="office-clock-face" d="M109 15h16v16h-16z"/>
      <path className="office-clock-hand" d="M116 17h2v8h5v2h-7z"/>
      <path className="office-shelf" d="M245 39h54v4h-54z"/><path className="office-pot" d="M262 30h16v9h-16z"/>
      <path className="office-leaf" d="M268 14h4v18h-4zm-10 4h10v4h-10zm-4-5h8v5h-8zm18 10h11v4h-11zm7-6h8v6h-8z"/>
      <path className="office-book" d="M250 33h8v6h-8zm9 0h7v6h-7zm8 0h9v6h-9z"/>
    </svg>
    <span className="office-clock-time">{clock}</span>
    {phase === "night" && <span className="office-lamp" aria-hidden="true" />}
  </div>;
}
const shortStatus: Record<string,string> = {working:"工作中",idle:"空闲",unknown:"待确认",done:"已完成",blocked:"等待处理",error:"卡住"};

function DetailCard({member, now, id}: {member: OfficeMember; now: number; id: string}) {
  const rows: [string, string][] = [];
  rows.push(["工位", member.tenure === "temporary" ? "临时" : "常驻"]);
  if (member.tenure === "temporary") {
    if (member.forTask) rows.push(["所属卡", `${member.forTask}${member.forTaskDone === true ? " · 已完成" : member.forTaskDone === false ? " · 进行中" : ""}`]);
    if (member.forTaskDone === true) rows.push(["回收", "待回收"]);
  }
  if (member.responsibilities) rows.push(["职责", member.responsibilities]);
  if (member.taskFull) rows.push(["当前任务", member.taskFull]);
  rows.push(["状态", `${member.status.label}${member.since ? ` · ${duration(member.since, now)}` : ""}`]);
  const machine = [member.machine, member.machineVersion].filter(Boolean).join(" · ");
  if (machine) rows.push(["机器", `${machine}${member.machineOnline === false ? "（离线）" : ""}`]);
  const updated = member.ai?.updatedAt ?? member.updatedAt;
  if (updated && Number.isFinite(Date.parse(updated))) rows.push(["最后更新", new Date(updated).toLocaleString()]);
  return <div className="office-detail" id={id} role="tooltip">
    <strong>{member.name}{member.isLead ? "（Lead）" : ""}</strong>
    {rows.map(([label, value]) => <p key={label}><span>{label}：</span>{value}</p>)}
    {member.ai && <div className="office-detail-ai">
      <p><span>AI 摘要：</span>{member.ai.summary}</p>
      {member.ai.evidence && <pre className="office-detail-evidence">{member.ai.evidence}</pre>}
    </div>}
  </div>;
}

/** The same presentation component serves the inline room and the isolated popup. */
export default function TeamOffice({snapshot, visible = true, onPopOut, onOpenMember, fullscreen = false, onFullscreenChange}: {
  snapshot: OfficeSnapshot; visible?: boolean; onPopOut?: () => void;
  fullscreen?: boolean; onFullscreenChange?: (value: boolean) => Promise<void>;
  /** Optional: click/Enter on a station opens that member's terminal in the main window. */
  onOpenMember?: (paletteKey: string) => void;
}) {
  const mailContainer=useRef<HTMLDivElement>(null);
  const projectElements = useRef(new Map<string, HTMLElement>());
  const [follow, setFollow] = useState(readFollow);
  const lastFollow = useRef("");
  const [scrollProject, setScrollProject] = useState("");
  const [manualHidden, setManualHidden] = useState(false);
  const [peek, setPeek] = useState(false);
  const [windowError, setWindowError] = useState("");
  const topHidden = (fullscreen || manualHidden) && !peek;
  const wasFullscreen = useRef(fullscreen);
  useEffect(() => {
    setPeek(false);
    if (wasFullscreen.current && !fullscreen) setManualHidden(false);
    wasFullscreen.current = fullscreen;
  }, [fullscreen]);
  const requestFullscreen = async (value: boolean) => {
    setWindowError("");
    try { await onFullscreenChange?.(value); }
    catch { setWindowError("无法切换全屏，请重试。"); }
  };
  useEffect(() => {
    if (!onFullscreenChange || !visible) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.key === "F11") { event.preventDefault(); void requestFullscreen(!fullscreen); }
      else if (event.key === "Escape" && fullscreen) { event.preventDefault(); void requestFullscreen(false); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [fullscreen, onFullscreenChange, visible]);
  const changeFollow = (enabled: boolean) => {
    setFollow(enabled);
    try { localStorage.setItem(FOLLOW_KEY, String(enabled)); } catch { /* storage is optional */ }
  };
  const [scaleMode, setScaleMode] = useState<ScaleMode>(readScale);
  const [roomSize, setRoomSize] = useState({width: 0, height: 0});
  const compactWall = roomSize.height < 520;
  const [collapsed,setCollapsed] = useState<Set<string>>(() => readCollapsed(snapshot.projects.map(project => project.id)));
  const knownProjects = useRef(new Set(snapshot.projects.map(project => project.id)));
  useEffect(() => {
    const newClosed = snapshot.projects.filter((project, index) => index > 0 && !knownProjects.current.has(project.id));
    knownProjects.current = new Set(snapshot.projects.map(project => project.id));
    if (newClosed.length) setCollapsed(previous => new Set([...previous, ...newClosed.map(project => project.id)]));
  }, [snapshot.projects]);
  useEffect(() => {
    if (!follow) { lastFollow.current = ""; setScrollProject(""); return; }
    const matches = snapshot.projects.filter(project => project.name === snapshot.activeProject);
    if (!matches.length) { lastFollow.current = ""; setScrollProject(""); return; }
    const identity = JSON.stringify(matches.map(project => project.id));
    if (identity === lastFollow.current) return;
    lastFollow.current = identity;
    const ids = new Set(matches.map(project => project.id));
    setCollapsed(new Set(snapshot.projects.filter(project => !ids.has(project.id)).map(project => project.id)));
    setScrollProject(matches[0].id);
  }, [follow, snapshot.activeProject, snapshot.projects]);
  useEffect(() => {
    const project = projectElements.current.get(scrollProject);
    if (project && mailContainer.current) mailContainer.current.scrollTo?.({top: project.offsetTop, behavior: "auto"});
  }, [scrollProject]);
  const openProjects = snapshot.projects.filter(project => !collapsed.has(project.id));
  const activeMembers = openProjects.flatMap(project => project.sources.flatMap(source => source.members));
  const furnitureFactor = activeMembers.some(member => member.isLead) ? 1.12 : 1;
  const wallHeight = topHidden ? 0 : compactWall ? 32 : Math.min(120, Math.max(48, window.innerHeight * .14));
  // Reserve project signs and the existing project/floor padding before fitting every station.
  const groups = openProjects.flatMap(project => project.sources.filter(source => source.members.length));
  const sourceOverhead = openProjects.reduce((sum, project) => sum + project.sources.reduce((height, source) => height +
    (source.members.length && (project.sources.length > 1 || source.label !== project.name) ? 32 : 0), 0), 0) + Math.max(0, groups.length - 1) * 30;
  const tempZones = groups.filter(source => source.members.some(member => member.tenure === "temporary")).length;
  const grid = fitOfficeGrid(activeMembers.length, Math.max(0, roomSize.width - 58),
    Math.max(0, roomSize.height - wallHeight - 64 * snapshot.projects.length - 74 - sourceOverhead), furnitureFactor > 1, groups.map(source => source.members.length), tempZones);
  const scale: OfficeScale = scaleMode === "auto" ? grid.scale : Number(scaleMode);
  const mailScale = scale < 1.5 ? 1 : scale < 2.5 ? 2 : 3;
  const avatarScale = scale === 1 || scale === 2 || scale === 3 ? scale : 1;
  useEffect(() => {
    const room = mailContainer.current;
    if (!room) return;
    const update = (width: number, height: number) => setRoomSize(previous => previous.width === width && previous.height === height ? previous : {width, height});
    update(room.clientWidth, room.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const entry = entries.find(item => item.target === room);
      if (entry) update(room.clientWidth || entry.contentRect.width, room.clientHeight || entry.contentRect.height);
    });
    observer.observe(room);
    return () => observer.disconnect();
  }, []);
  const changeScale = (value: ScaleMode) => {
    setScaleMode(value);
    try { localStorage.setItem(SCALE_KEY, value); } catch { /* storage is optional */ }
  };
  const [hidden,setHidden] = useState(() => document.hidden);
  const [now,setNow] = useState(() => new Date());
  const [reduced,setReduced] = useState(() => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);
  useEffect(() => {
    const update = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange",update);
    return () => document.removeEventListener("visibilitychange",update);
  }, []);
  const paused = !visible || hidden;
  // Only the clock/relative-time tick re-renders the room, and only while visible;
  // a disabled room leaves no timer behind (popup windows and hidden tabs stay idle).
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [paused]);
  const totals = officeStatusCounts(snapshot.projects.flatMap(project => project.sources.flatMap(source => source.members)));
  const serviceWarning = snapshot.service && ["offline", "error", "unauthorized"].includes(snapshot.service.state);
  const motion = snapshot.animationEnabled && !reduced;
  const phase = skyPhase(now);
  const seconds = Math.floor(now.getTime() / 1000);
  const toggle = (id: string) => setCollapsed(previous => {
    const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id);
    writeCollapsed(next);
    return next;
  });
  return <section className="team-office" aria-label="公司办公室" data-paused={String(paused)} data-motion={motion?"on":"off"} data-phase={phase}
    data-follow={String(follow)} data-fullscreen={String(fullscreen)} data-top-hidden={String(topHidden)}
    onMouseMove={event => {
      const y = event.clientY - event.currentTarget.getBoundingClientRect().top;
      if ((fullscreen || manualHidden) && y >= 0 && y < 8) setPeek(true);
      else if (peek && y > 32 + (compactWall ? 32 : Math.min(120, Math.max(48, window.innerHeight * .14))) + 24) setPeek(false);
    }}
    data-scale={scale} data-columns={grid.columns} data-rows={grid.rows} data-scale-mode={scaleMode} data-compact-wall={String(compactWall)} data-compact-label={String(scale < 1.75)}
    style={{"--office-text": textScale(scale), "--office-columns": scaleMode === "auto" ? grid.columns : undefined, "--office-station-width": `${Math.max(160, 96 * scale * furnitureFactor)}px`} as CSSProperties}>
    {topHidden && <button className="office-top-reveal" aria-label="显示顶部" onFocus={() => setPeek(true)} onClick={() => setPeek(true)}/>}
    <header className="office-toolbar"><span className="office-overview"><span className="office-service-dot" data-online={String(snapshot.service?.state === "online")} aria-label={snapshot.service?.state === "online" ? "服务在线" : "服务未连接"}/><span>工作中 {totals.running} · 卡住 {totals.stuck} · 等待 {totals.waiting}</span></span><div>
      <label><input type="checkbox" checked={follow} onChange={event => changeFollow(event.target.checked)}/>跟随当前窗口</label>
      <button type="button" onClick={() => {setManualHidden(value => !value);setPeek(false);}}>{manualHidden ? "显示顶部" : "隐藏顶部"}</button>
      {onFullscreenChange && <button type="button" onClick={() => void requestFullscreen(!fullscreen)}>{fullscreen ? "退出全屏" : "全屏"}</button>}
      <label><select aria-label="房间像素缩放" value={scaleMode} onChange={event => changeScale(event.target.value as ScaleMode)}>
        <option value="auto">自适应</option><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option>
      </select></label>{onPopOut && <Button size="sm" variant="outline" onClick={onPopOut}>弹出窗口</Button>}
    </div></header>
    {windowError && <p className="office-window-error" role="alert">{windowError}</p>}
    {serviceWarning && <p className="office-coverage" role="status">{serviceNote(snapshot.service)}</p>}
    <div className="office-projects" ref={mailContainer}>
      <UpperWall phase={phase} clock={clockText(now)}/>
      {!snapshot.projects.length && <div className="office-unassigned"><p className="office-empty">暂无已登记的团队。先在 Lead 终端的团队面板登记项目。</p><EmptyDesks scale={scale}/></div>}
      {snapshot.projects.map(project => {
        const closed = collapsed.has(project.id);
        const members = project.sources.flatMap(source => source.members);
        const counts = officeStatusCounts(members);
        return <section className="office-project" aria-label={`项目 ${project.name}`} key={project.id} ref={element => {if(element)projectElements.current.set(project.id, element);else projectElements.current.delete(project.id);}} data-paused={String(paused || closed)}>
          <button className="office-project-sign" aria-label={`${closed?"展开":"折叠"}项目 ${project.name}`} aria-expanded={!closed} onClick={() => toggle(project.id)}>
            <span aria-hidden="true">{closed?"▸":"▾"}</span> {project.name}
            <span className="office-project-counts" aria-label="团队状态计数">{[["运行中", counts.running], ["等待", counts.waiting], ["卡住", counts.stuck], ["空闲", counts.idle], ["离线", counts.offline]].filter(([, count]) => Number(count) > 0).map(([label, count]) => `${label} ${count}`).join(" · ")}</span>
            <small>{members.length} 人</small>
          </button>
          <div hidden={closed} className="office-project-floor">
            {!project.sources.length && <EmptyDesks scale={scale}/>}
            {project.sources.map(source => <section className="office-source" key={source.id} aria-label={source.label}>
              {(project.sources.length > 1 || source.label !== project.name) && <p className="office-source-label">{source.label}</p>}
              {source.availability !== "ready" ? <p role="status" className="office-source-notice">{source.notice}</p>
                : !source.members.length ? <p className="office-source-notice">此团队尚未登记成员。</p> : null}
              {!source.members.length && <EmptyDesks scale={scale}/>}
              {(() => {
                const station = (member: OfficeMember) => {
                  const ended = member.match === "gone" || member.match === "replaced";
                  const temporary = member.tenure === "temporary";
                  const reclaim = temporary && member.forTaskDone === true;
                  const quiet = priority(member) >= 3;
                  const grey = priority(member) === 4;
                  const urgent = priority(member) <= 1;
                  const oldAi = member.ai && Number.isFinite(Date.parse(member.ai.updatedAt)) && (now.getTime() - Date.parse(member.ai.updatedAt)) > 30 * 60_000;
                  const bubbleText = member.ai?.summary || member.status.label;
                  const bubbleLimit = scale < 1.75 ? 16 : 20;
                  const detailId = `office-detail-${member.id}`;
                  const open = () => onOpenMember?.(member.paletteKey);
                  const factor = member.isLead ? 1.12 : 1;
                  const stateClass = `office-state-${member.liveState ?? member.status.state}`;
                  // One placement for both prompts: inside the desk box, below the bubble slot.
                  const badge = ["waiting_input", "input_pending"].includes(member.liveState ?? "") || member.status.state === "blocked"
                    ? "warn" : member.liveState === "stuck" || member.status.state === "error" ? "alert" : "";
                  return <article className={`office-station${member.isLead?" is-lead":""}${temporary?" is-temporary":""}${reclaim?" is-reclaim":""}${ended?" is-ended":""}${grey?" is-grey":""}${quiet?" is-quiet":""}${member.liveState==="stuck"||member.status.state==="error"?" is-stuck":""} ${stateClass}`}
                    key={member.id} data-member-id={member.id} data-office-station={officeStationAnchor(source.id,member.id)}
                    data-tenure={temporary ? "temporary" : "resident"} data-for-task={member.forTask ?? ""} data-for-task-done={member.forTaskDone === true ? "true" : ""}
                    data-state={member.status.state} data-live-state={member.liveState ?? ""} data-match={member.match ?? ""}
                    data-palette-key={member.paletteKey} aria-label={`工位 ${member.name}`} aria-describedby={detailId}
                    tabIndex={0} onClick={open} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } }}>
                    <span className="office-sr-only">{member.status.label}</span>
                    <div className="office-ai-slot">
                      {((member.ai && !(quiet && oldAi)) || urgent) && <div className={`office-ai-bubble${oldAi && !urgent?" is-old":""}`} title={`AI 摘要（${relative(member.ai?.updatedAt ? Date.parse(member.ai.updatedAt)/1000 : undefined, seconds)}）`}>
                        <span className="office-ai-text">{bubbleText.length > bubbleLimit ? `${bubbleText.slice(0, bubbleLimit)}…` : bubbleText}</span>
                        <small>{relative(member.ai?.updatedAt ? Date.parse(member.ai.updatedAt)/1000 : undefined, seconds)}</small>
                      </div>}
                    </div>
                    <div className="office-pixels" style={{width:96*scale*factor,height:72*scale*factor}}>
                      <div className="office-furniture-scale" style={{width:96*scale,height:72*scale,transform:`scale(${factor})`}}>
                        <Desk scale={scale} lead={member.isLead}/>
                      </div>
                      {ended
                        ? <div className="office-empty-chair" aria-hidden="true"><svg width={20*scale} height={18*scale} viewBox="0 0 20 18" shapeRendering="crispEdges"><path className="office-chair" d="M3 1h14v8H3zm2 8h10v6H5zm-2 6h14v3H3z"/></svg></div>
                        : <div className="office-person" style={{left:20*scale*factor,top:14*scale*factor}}><div style={{width:28*scale,height:32*scale}}><div style={{width:28*avatarScale,height:32*avatarScale,transform:`scale(${scale/avatarScale})`,transformOrigin:"top left"}}><TeamMemberAvatar memberId={member.paletteKey} status={member.status} scale={avatarScale} motionEnabled={motion} paused={paused || closed}/></div></div></div>}
                      {badge && <span className={`office-state-badge is-${badge}`} aria-hidden="true">{badge === "warn" ? "?" : "!"}</span>}
                    </div>
                    <div className="office-desk-label">
                        <div className="office-station-name">
                          {member.isLead && <span className="office-lead-label">Lead</span>}
                          {member.tool && <span className="office-tool" title={`工具 ${member.tool}`}>{TOOL_LABELS[member.tool] ?? member.tool}</span>}
                          <strong title={member.name}>{member.name}</strong>
                        </div>
                        <div className="office-status-line"><span className="office-member-status" title={member.status.label}>{shortStatus[member.status.state] ?? STATE_LABELS[member.status.state] ?? member.status.label}</span></div>
                    {reclaim && <div className="office-station-flags"><span className="office-reclaim-badge" title={`${member.forTask ?? ""} · 已完成`}>待回收</span></div>}
                    {!quiet && <p className="office-member-task office-station-paper" title={`${member.taskSource==="manual"?"成员手写 · ":""}${member.taskFull || member.taskText}`} data-source={member.taskSource}>{member.taskSource==="manual" && <span className="office-sr-only">成员手写 · </span>}{member.taskText}</p>}
                    {temporary && member.forTask && <p className="office-temp-task"><code>{member.forTask}</code></p>}
                    </div>
                    <DetailCard member={member} now={seconds} id={detailId}/>
                  </article>;
                };
                const ordered = sortedMembers(source.members);
                const residents = ordered.filter(member => member.tenure !== "temporary");
                const temporary = ordered.filter(member => member.tenure === "temporary");
                return <>
                  <div className="office-desks">{residents.map(station)}</div>
                  {temporary.length > 0 && <section className="office-temp-zone" aria-label="临时工位">
                    <p className="office-temp-heading"><span aria-hidden="true">◷</span> 临时工位</p>
                    <div className="office-desks">{temporary.map(station)}</div>
                  </section>}
                </>;
              })()}
            </section>)}
          </div>
        </section>;
      })}
      <OfficeMail scale={mailScale} mail={snapshot.mail} paused={paused} motion={motion} container={mailContainer} layoutKey={[scale,collapsed,snapshot.projects]}/>
    </div>
    <footer className="office-mailbox"><span aria-hidden="true">✉</span> {mailNote(snapshot.mail, snapshot.mailAvailability)}</footer>
  </section>;
}
