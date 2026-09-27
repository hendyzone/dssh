import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

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
}
const states = new Map<string, TaskStatus>();
const tails = new Map<string, string>();
const subscribers = new Set<() => void>();
let focused = "";
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
  focused = id;
  let changed = false;
  states.forEach((task, key) => {
    if ((key === id || task.sourcePaneId === id) && task.unread) {
      states.set(key, { ...task, unread: false }); changed = true;
    }
  });
  if (changed) subscribers.forEach((fn) => fn());
}
export function removeTask(id: string) {
  states.delete(id);
  tails.delete(id);
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
  metadata?: Pick<TaskStatus, "provider" | "sourcePaneId">,
) {
  const old = states.get(id);
  const meta = metadata ?? (old?.provider ? { provider: old.provider, sourcePaneId: old.sourcePaneId } : undefined);
  const background=(focused !== id && focused !== meta?.sourcePaneId) || document.hidden || !document.hasFocus();
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
export function ingestTaskOutput(id: string, name: string, chunk: string) {
  const linked = [...states.values()].find(task => task.sourcePaneId === id && task.provider);
  const combined = (tails.get(id) ?? "") + chunk;
  tails.set(id, combined.slice(-8192));
  // Explicit terminal notification protocols, including a small adapter protocol.
  const matches = [
    ...combined.matchAll(
      /\x1b\](?:777;notify;([^;]*);([^\x07\x1b]*)|9;([^\x07\x1b]*)|777;dssh;(running|working|waiting|idle|done|error);([^\x07\x1b]*))(?:\x07|\x1b\\)/g,
    ),
  ];
  if (matches.length) {
    const m = matches[matches.length - 1];
    tails.set(id, combined.slice((m.index ?? 0) + m[0].length));
    if (linked && !m[4]) return; // Generic OSC toasts must not overwrite lifecycle hooks.
    reportTask(
      linked?.id ?? id,
      linked?.name ?? name,
      (m[4] as TaskPhase) || "waiting",
      m[5] || m[2] || m[3] || m[1] || "工具发出通知",
      false,
      true,
      undefined,
      linked ? { provider: linked.provider, sourcePaneId: linked.sourcePaneId } : undefined,
    );
    return;
  }
  const text = chunk
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f]/g, " ");
  if (linked && linked.provider !== "pi") return;
  if (
    /(?:Do you want to proceed|Allow this|needs your (?:input|permission)|是否允许|需要批准)/i.test(
      text,
    )
  ) {
    reportTask(linked?.id ?? id, linked?.name ?? name, "waiting", "终端出现确认提示", true, true, undefined,
      linked ? { provider: linked.provider, sourcePaneId: linked.sourcePaneId } : undefined);
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
  if (
    !old ||
    old.phase === "quiet" ||
    old.phase === "disconnected" ||
    old.phase === "running"
  )
    reportTask(id, name, "running", "根据终端输出判断", true);
}
