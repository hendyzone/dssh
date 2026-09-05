export type TaskPhase =
  | "running"
  | "waiting"
  | "done"
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
}
const states = new Map<string, TaskStatus>();
const tails = new Map<string, string>();
const subscribers = new Set<() => void>();
let focused = "";
let desktop = false;
export const taskLabels: Record<TaskPhase, string> = {
  running: "有新输出",
  waiting: "需要关注",
  done: "已完成",
  error: "出现错误",
  quiet: "暂时无输出",
  disconnected: "连接断开",
};
export function taskSnapshot() {
  return [...states.values()].sort((a, b) => b.updated - a.updated);
}
export function subscribeTasks(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
export function focusTask(id: string) {
  focused = id;
  const task = states.get(id);
  if (task?.unread) {
    states.set(id, { ...task, unread: false });
    subscribers.forEach((fn) => fn());
  }
}
export function removeTask(id: string) {
  states.delete(id);
  tails.delete(id);
  subscribers.forEach((fn) => fn());
}
export async function enableDesktopNotifications() {
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
) {
  const old = states.get(id);
  const background=focused !== id || document.hidden || !document.hasFocus();
  const important = ["waiting", "done", "error", "disconnected"].includes(
    phase,
  );
  const changed = !old || old.phase !== phase || old.message !== message;
  if (!changed && Date.now() - (old?.updated ?? 0) < 1500) return;
  states.set(id, {
    id,
    name,
    phase,
    message: message.slice(0, 240),
    estimated,
    updated: Date.now(),
    unread: important && background && (changed || !!old?.unread),
  });
  if (
    important &&
    changed &&
    background &&
    desktop &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  ) {
    try {
      new Notification(name, {
        body: taskLabels[phase] + (estimated ? "（推测）" : ""),
        tag: id,
      });
    } catch {}
  }
  subscribers.forEach((fn) => fn());
}
export function ingestTaskOutput(id: string, name: string, chunk: string) {
  const combined = (tails.get(id) ?? "") + chunk;
  tails.set(id, combined.slice(-8192));
  // Explicit terminal notification protocols, including a small adapter protocol.
  const matches = [
    ...combined.matchAll(
      /\x1b\](?:777;notify;([^;]*);([^\x07\x1b]*)|9;([^\x07\x1b]*)|777;dssh;(running|waiting|done|error);([^\x07\x1b]*))(?:\x07|\x1b\\)/g,
    ),
  ];
  if (matches.length) {
    const m = matches[matches.length - 1];
    tails.set(id, combined.slice((m.index ?? 0) + m[0].length));
    reportTask(
      id,
      name,
      (m[4] as TaskPhase) || "waiting",
      m[5] || m[2] || m[3] || m[1] || "工具发出通知",
      false,
    );
    return;
  }
  const text = chunk
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f]/g, " ");
  if (
    /(?:Do you want to proceed|Allow this|needs your (?:input|permission)|是否允许|需要批准)/i.test(
      text,
    )
  ) {
    reportTask(id, name, "waiting", "终端出现确认提示", true);
    return;
  }
  if (/(?:Worked for \d|task completed|任务已完成)/i.test(text)) {
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
