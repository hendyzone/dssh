import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { ProgramStatusTracker, type ProgramStatusRecord, type ProgramStatusState, type ProgramStatusKind } from "./programStatus";
import type { TmuxProgramPane } from "./tmuxProgramStatus";

export interface TaskTmuxTarget {
  serverId: string;
  sessionId: string;
  sessionCreated: number;
  sessionName: string;
  paneId: string;
}

export type TaskPhase =
  | "ready"
  | "stopped"
  | "running"
  | "working"
  | "waiting"
  | "done"
  | "idle"
  | "error"
  | "quiet"
  | "disconnected";
export interface TaskStatus {
  id: string;
  name: string;
  phase: TaskPhase;
  message: string;
  estimated: boolean;
  updated: number;
  unread: boolean;
  provider?: "claude" | "codex" | "pi";
  sourcePaneId?: string;
  protocol?: "osc7501";
  programState?: ProgramStatusState;
  recordId?: string;
  app?: string;
  title?: string;
  kind?: ProgramStatusKind;
  progress?: number;
  protocolScope?: "terminal" | "tmux-client" | "tmux-pane";
  tmux?: TaskTmuxTarget;
}
const states = new Map<string, TaskStatus>();
interface ProgramTerminal { tracker: ProgramStatusTracker; name: string; tmux: boolean; authoritative: boolean }
const programs = new Map<string, ProgramTerminal>();
const lastProgramNotification = new Map<string, number>();
const subscribers = new Set<() => void>();
let focused = "";
let focusedTmux = "";
let focusedTmuxTarget: TaskTmuxTarget | undefined;
let desktop = false;
const openTask = (id: string) => window.dispatchEvent(new CustomEvent("dssh-open-task", { detail: id }));
export const taskLabels: Record<TaskPhase, string> = {
  ready: "等待输入",
  stopped: "工具已退出",
  running: "有新输出",
  working: "处理中",
  waiting: "需要关注",
  done: "已完成",
  idle: "本轮已结束",
  error: "出现错误",
  quiet: "暂时无输出",
  disconnected: "连接断开",
};
export function taskSnapshot() {
  const linked = new Set([...states.values()].map(task => task.sourcePaneId).filter(Boolean));
  return [...states.values()].filter(task => !linked.has(task.id)).sort((a, b) => b.updated - a.updated);
}
export function subscribeTasks(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
export function focusTask(id: string) {
  const selected = states.get(id);
  const next = selected?.sourcePaneId ?? id;
  if (selected?.tmux) {
    focusedTmuxTarget = selected.tmux;
    focusedTmux = tmuxProgramTaskId(selected.tmux);
  } else if (next !== focused) {
    focusedTmuxTarget = undefined;
    focusedTmux = "";
  }
  focused = next;
  let changed = false;
  states.forEach((task, key) => {
    const visible = task.tmux ? tmuxProgramTaskId(task.tmux) === focusedTmux :
      key === id || key === focused || task.sourcePaneId === focused;
    if (visible && task.unread) {
      states.set(key, { ...task, unread: false }); changed = true;
    }
  });
  if (changed) subscribers.forEach((fn) => fn());
}
/** A fresh server snapshot identifies the pane actually visible in this client. */
export function focusTmuxPane(sourcePaneId: string, target?: TaskTmuxTarget) {
  focused = sourcePaneId;
  focusedTmuxTarget = target;
  focusedTmux = target ? tmuxProgramTaskId(target) : "";
  focusTask(sourcePaneId);
}
export function removeTask(id: string) {
  states.delete(id);
  programs.delete(id);
  lastProgramNotification.delete(id);
  states.forEach((task, key) => {
    if (task.protocol === "osc7501" && task.sourcePaneId === id) states.delete(key);
  });
  subscribers.forEach((fn) => fn());
}
export async function enableDesktopNotifications() {
  if ("__TAURI_INTERNALS__" in window) {
    desktop = await isPermissionGranted() || await requestPermission() === "granted";
    if (!desktop) throw new Error("未授予通知权限，仍会显示应用内提醒");
    return;
  }
  if (typeof Notification === "undefined")
    throw new Error("此系统未提供桌面通知，仍会显示应用内提醒");
  const result = await Notification.requestPermission();
  desktop = result === "granted";
  if (!desktop) throw new Error("未授予通知权限，仍会显示应用内提醒");
}
export function acknowledgeTasks() {
  states.forEach((task, id) => states.set(id, { ...task, unread: false }));
  subscribers.forEach((fn) => fn());
}
export function reportTask(
  id: string,
  name: string,
  phase: TaskPhase,
  message: string,
  estimated = false,
  notify = true,
  eventTime?: number,
  metadata?: Pick<TaskStatus, "provider" | "sourcePaneId" | "tmux">,
) {
  const old = states.get(id);
  const meta = metadata ?? (old?.provider ? { provider: old.provider, sourcePaneId: old.sourcePaneId, tmux: old.tmux } : undefined);
  // A real program report owns its status; delayed Hook polls must not replace it.
  if (meta?.provider && nativeOwnsHook(meta)) {
    if (states.delete(id)) subscribers.forEach(fn => fn());
    return;
  }
  const background=(meta?.tmux ? focusedTmux !== tmuxProgramTaskId(meta.tmux) : focused !== id && focused !== meta?.sourcePaneId) || document.hidden || !document.hasFocus();
  const important = ["waiting", "done", "idle", "error", "disconnected"].includes(
    phase,
  );
  const changed = !old || old.phase !== phase || old.message !== message || old.estimated !== estimated || old.sourcePaneId !== meta?.sourcePaneId || (eventTime !== undefined && old.updated !== eventTime);
  if (!changed && Date.now() - (old?.updated ?? 0) < 1500) return;
  states.set(id, {
    id,
    name,
    phase,
    message: message.slice(0, 240),
    estimated,
    updated: eventTime ?? Date.now(),
    unread: important && background && ((notify && changed) || !!old?.unread),
    ...meta,
  });
  if (
    important &&
    notify &&
    changed &&
    background &&
    desktop
  ) {
    try {
      if ("__TAURI_INTERNALS__" in window) {
        sendNotification({title:name, body:taskLabels[phase] + (estimated ? "（推测）" : ""), extra: { taskId: id }});
      } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const notice = new Notification(name, {
        body: taskLabels[phase] + (estimated ? "（推测）" : ""),
        tag: id,
      });
        notice.onclick = () => { window.focus(); openTask(id); notice.close(); };
      }
    } catch {}
  }
  subscribers.forEach((fn) => fn());
}
// Strip invisible formatting only for presentation; validate protocol text first.
const displayText = (text: string) => text.replace(/[\p{Cf}\p{Cc}]/gu, "");
export const programTaskId = (paneId: string, recordId: string) =>
  `osc7501:${encodeURIComponent(paneId)}:${recordId}`;

function nativeOwnsHook(meta: Pick<TaskStatus, "provider" | "sourcePaneId" | "tmux">) {
  if (!meta.provider) return false;
  const sameApp = (task: TaskStatus) => task.app === meta.provider || (meta.provider === "claude" && task.app === "claude-code");
  if (meta.tmux) {
    const task = states.get(tmuxProgramTaskId(meta.tmux));
    // tmux retains idle/done/error across prompts without a lifecycle revision.
    // Persistent records must not suppress a later Hooks-only program run.
    return !!task && task.phase !== "disconnected" &&
      (task.programState === "working" || task.programState === "blocked") && sameApp(task);
  }
  if (!meta.sourcePaneId) return false;
  const terminal = programs.get(meta.sourcePaneId);
  // A tmux client's output cannot identify the internal pane that emitted it.
  if (!terminal?.authoritative || terminal.tmux) return false;
  return [...states.values()].some(task => task.protocol === "osc7501" && task.sourcePaneId === meta.sourcePaneId &&
    sameApp(task));
}

export const tmuxProgramTaskId = (target: Omit<TaskTmuxTarget, "sessionName">) =>
  `tmux-ps:${encodeURIComponent(target.serverId)}:${target.sessionId}:${target.sessionCreated}:${target.paneId}`;

/** The patched tmux exposes a root record per pane, without a revision or event log. */
export function syncTmuxProgramStatus(serverId: string, hostName: string, panes: TmuxProgramPane[], notify: boolean) {
  // Reconcile remote focus BEFORE classifying transitions: the old active pane
  // may have moved into the background and completed in this same snapshot.
  if (focusedTmuxTarget?.serverId === serverId) {
    const active = panes.find(pane => pane.sessionId === focusedTmuxTarget!.sessionId &&
      pane.sessionCreated === focusedTmuxTarget!.sessionCreated && pane.windowActive && pane.paneActive);
    focusedTmuxTarget = active ? { serverId, sessionId: active.sessionId, sessionCreated: active.sessionCreated,
      sessionName: active.sessionName, paneId: active.paneId } : undefined;
    focusedTmux = focusedTmuxTarget ? tmuxProgramTaskId(focusedTmuxTarget) : "";
  }
  const next = new Set<string>();
  for (const pane of panes) {
    if (!pane.state) continue;
    const tmux: TaskTmuxTarget = { serverId, sessionId: pane.sessionId, sessionCreated: pane.sessionCreated,
      sessionName: pane.sessionName, paneId: pane.paneId };
    const id = tmuxProgramTaskId(tmux);
    next.add(id);
    const old = states.get(id);
    const phase: TaskPhase = pane.state === "idle" ? "ready" : pane.state === "blocked" ? "waiting" : pane.state;
    const message = displayText(pane.msg ?? "").slice(0, 240);
    const title = displayText(pane.title ?? "");
    const changed = !old || old.programState !== pane.state || old.kind !== pane.kind ||
      old.message !== message || old.title !== title || old.app !== pane.app;
    const background = focusedTmux !== id || document.hidden || !document.hasFocus();
    const important = pane.state === "blocked" || pane.state === "done" || pane.state === "error";
    const unread = important && background && ((notify && changed) || !!old?.unread);
    const name = `${hostName} · ${displayText(pane.sessionName)} ${pane.paneId}`;
    states.set(id, { id, name, phase, message, estimated: false,
      updated: changed || old?.progress !== pane.progress ? Date.now() : old.updated,
      unread, protocol: "osc7501", protocolScope: "tmux-pane", programState: pane.state,
      recordId: "", app: pane.app, title, kind: pane.kind, progress: pane.progress, tmux });
    const now = Date.now();
    if (notify && changed && unread && desktop && now - (lastProgramNotification.get(id) ?? -Infinity) >= 5000) {
      lastProgramNotification.set(id, now);
      try {
        if ("__TAURI_INTERNALS__" in window) {
          void sendNotification({ title: name, body: taskLabels[phase], extra: { taskId: id } });
        } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          const notice = new Notification(name, { body: taskLabels[phase], tag: id });
          notice.onclick = () => { window.focus(); openTask(id); notice.close(); };
        }
      } catch {}
    }
  }
  states.forEach((task, id) => {
    if (task.protocolScope === "tmux-pane" && task.tmux?.serverId === serverId && !next.has(id)) {
      states.delete(id); lastProgramNotification.delete(id);
    }
  });
  states.forEach((task, id) => { if (task.provider && nativeOwnsHook(task)) states.delete(id); });
  subscribers.forEach(fn => fn());
}

export function removeTmuxProgramStatus(serverId: string) {
  syncTmuxProgramStatus(serverId, "", [], false);
}

export function disconnectTmuxProgramStatus(serverId: string) {
  states.forEach((task, id) => {
    if (task.protocolScope === "tmux-pane" && task.tmux?.serverId === serverId)
      states.set(id, { ...task, phase: "disconnected", message: "无法读取 tmux 程序状态" });
  });
  subscribers.forEach(fn => fn());
}

function syncProgramRecords(paneId: string, terminal: ProgramTerminal, records: ProgramStatusRecord[], reportedId?: string) {
  const ids = new Set(records.map(record => programTaskId(paneId, record.id)));
  states.forEach((task, id) => {
    if (task.protocol === "osc7501" && task.sourcePaneId === paneId && !ids.has(id)) states.delete(id);
  });
  const background = focused !== paneId || document.hidden || !document.hasFocus();
  for (const record of records) {
    const id = programTaskId(paneId, record.id);
    const old = states.get(id);
    const phase: TaskPhase = record.state === "blocked" ? "waiting" : record.state === "idle" ? "ready" : record.state;
    const changed = !old || old.programState !== record.state || old.kind !== record.kind ||
      old.message !== displayText(record.msg ?? "").slice(0, 240) || old.title !== displayText(record.title ?? "") || old.app !== record.app;
    const important = record.state === "blocked" || record.state === "done" || record.state === "error";
    const reported = record.id === reportedId;
    const unread = important && background && ((reported && changed) || !!old?.unread);
    const task: TaskStatus = {
      id, name: terminal.name, phase, message: displayText(record.msg ?? "").slice(0, 240),
      estimated: false, updated: record.updatedAt, unread,
      protocol: "osc7501", programState: record.state, sourcePaneId: paneId,
      protocolScope: terminal.tmux ? "tmux-client" : "terminal",
      recordId: record.id, app: record.app, title: displayText(record.title ?? ""),
      kind: record.kind, progress: record.progress,
    };
    states.set(id, task);
    // Progress updates and repeated reports must not generate a notification storm.
    const now = Date.now();
    if (reported && changed && unread && desktop && now - (lastProgramNotification.get(paneId) ?? -Infinity) >= 5000) {
      lastProgramNotification.set(paneId, now);
      try {
        if ("__TAURI_INTERNALS__" in window) {
          void sendNotification({ title: terminal.name, body: taskLabels[phase], extra: { taskId: id } });
        } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
          const notice = new Notification(terminal.name, { body: taskLabels[phase], tag: paneId });
          notice.onclick = () => { window.focus(); openTask(id); notice.close(); };
        }
      } catch {}
    }
  }
  // Discard superseded Hook snapshots: replaying an old revision after clear or
  // a prompt could resurrect stale working/blocked state. New Hook events resume.
  states.forEach((task, id) => { if (task.provider && nativeOwnsHook(task)) states.delete(id); });
  subscribers.forEach(fn => fn());
}

/** Clear transient records at PTY exit; completed results remain until replaced/cleared. */
export function endTaskTerminal(paneId: string) {
  const terminal = programs.get(paneId);
  if (!terminal) return;
  const event = terminal.tracker.processExit();
  terminal.authoritative = false;
  syncProgramRecords(paneId, terminal, event.records);
}

/** Streaming protocol processing is independent of rendering and terminal focus.
 * Only fixed feature-detection replies are returned to the PTY, never report content.
 */
export function ingestTaskOutput(id: string, name: string, chunk: string, options: { tmux?: boolean } = {}): string[] {
  let terminal = programs.get(id);
  if (!terminal) {
    terminal = { tracker: new ProgramStatusTracker(), name, tmux: !!options.tmux, authoritative: false };
    programs.set(id, terminal);
  }
  terminal.name = name;
  terminal.tmux = !!options.tmux;
  const replies: string[] = [];
  let text = "";
  const flushText = () => {
    if (text && !terminal.authoritative) ingestTaskText(id, name, text);
    text = "";
  };
  for (const event of terminal.tracker.feed(chunk)) {
    if (event.type === "text") { text += event.text; continue; }
    flushText();
    if (event.type === "query") {
      // tmux sends replies to the active pane, which may not be the requester.
      if (!terminal.tmux) replies.push(event.reply);
    } else if (event.type === "legacy-osc") {
      if (!terminal.authoritative) ingestLegacyOsc(id, name, event.body);
    } else {
      if (event.type === "report" || event.type === "clear") {
        terminal.authoritative = true;
        states.delete(id);
      } else {
        terminal.authoritative = false;
      }
      syncProgramRecords(id, terminal, event.records, event.type === "report" ? event.record.id : undefined);
    }
  }
  flushText();
  return replies;
}

function ingestLegacyOsc(id: string, name: string, body: string) {
  // OSC 9;4 is progress, never an iTerm notification. We do not map it.
  if (body.startsWith("9;4;")) return;
  const linked = [...states.values()].find(task => task.sourcePaneId === id && task.provider);
  const m = /^(?:777;notify;([^;]*);(.*)|9;(.*)|777;dssh;(running|working|waiting|idle|done|error);(.*))$/s.exec(body);
  if (!m || (linked && !m[4])) return;
  reportTask(linked?.id ?? id, linked?.name ?? name, (m[4] as TaskPhase) || "waiting",
    m[5] || m[2] || m[3] || m[1] || "工具发出通知", false, true, undefined,
    linked ? { provider: linked.provider, sourcePaneId: linked.sourcePaneId, tmux: linked.tmux } : undefined);
}

function ingestTaskText(id: string, name: string, text: string) {
  if (!text.trim()) return;
  const linked = [...states.values()].find(task => task.sourcePaneId === id && task.provider);
  if (linked && linked.provider !== "pi") return;
  if (/(?:Do you want to proceed|Allow this|needs your (?:input|permission)|是否允许|需要批准)/i.test(text)) {
    reportTask(linked?.id ?? id, linked?.name ?? name, "waiting", "终端出现确认提示", true, true, undefined,
      linked ? { provider: linked.provider, sourcePaneId: linked.sourcePaneId, tmux: linked.tmux } : undefined);
    return;
  }
  if (linked) return;
  if (/Worked for \d/i.test(text)) {
    reportTask(id, name, "idle", "终端出现本轮结束提示", true);
    return;
  }
  if (/(?:task completed|任务已完成)/i.test(text)) {
    reportTask(id, name, "done", "终端出现完成提示", true);
    return;
  }
  if (/(?:fatal error|connection refused|uncaught exception)/i.test(text)) {
    reportTask(id, name, "error", "终端出现错误提示", true);
    return;
  }
  const old = states.get(id);
  if (!old || old.phase === "quiet" || old.phase === "disconnected" || old.phase === "running")
    reportTask(id, name, "running", "根据终端输出判断", true);
}
