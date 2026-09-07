import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TmuxSession } from "./tmux";
import { reportTask, removeTask } from "./taskStatus";

export type ClaudePhase = "starting" | "ready" | "running" | "waiting" | "idle" | "error" | "stopped";
export interface ClaudeTask {
  id: string; title: string; repo: string; path: string; branch: string; base: string;
  created: number; tmux: TmuxSession | null;
  status: {phase: ClaudePhase; updated: number; sessionId?: string};
}
export const claudeLabels: Record<ClaudePhase, string> = {
  starting: "等待 Claude 启动", ready: "等待输入", running: "处理中", waiting: "需要确认或输入",
  idle: "本轮已结束", error: "运行出错", stopped: "Claude 已退出",
};
export interface ClaudeHost {serverId: string; name: string; sessionId: string}
export interface ClaudeSnapshot {tasks: ClaudeTask[]; error: string; loading: boolean}
export const claudeTaskId = (serverId: string, taskId: string) => `claude:${serverId}:${taskId}`;
export function useClaudeStatus(hosts: ClaudeHost[]) {
  const [snapshots, setSnapshots] = useState<Record<string, ClaudeSnapshot>>({});
  const key = JSON.stringify(hosts);
  useEffect(() => {
    const current: ClaudeHost[] = JSON.parse(key);
    let disposed = false;
    const taskIds = new Set<string>();
    const pending = new Set<string>();
    const seen = new Map<string, string>();
    const poll = async (host: ClaudeHost) => {
      if (pending.has(host.serverId)) return;
      pending.add(host.serverId);
      try {
        const tasks = await invoke<ClaudeTask[]>("claude_status", {sessionId:host.sessionId});
        if (disposed) return;
        setSnapshots(old => ({...old, [host.serverId]:{tasks, error:"", loading:false}}));
        for (const task of tasks) {
          const id = claudeTaskId(host.serverId, task.id);
          taskIds.add(id);
          const revision = `${task.status.updated}:${task.status.phase}`;
          // Only event changes produce reminders. Silence is never completion.
          if (seen.get(id) === revision) continue;
          const notify = seen.has(id);
          seen.set(id, revision);
          const phase = task.status.phase;
          reportTask(id, `${host.name} · ${task.title}`,
            phase === "idle" ? "idle" : phase === "waiting" ? "waiting" : phase === "error" ? "error" : phase === "running" ? "working" : "quiet",
            claudeLabels[phase], false, notify, task.status.updated);
        }
      } catch (error) {
        if (disposed) return;
        setSnapshots(old => ({...old, [host.serverId]:{tasks:old[host.serverId]?.tasks ?? [], error:`状态未知：${String(error)}`, loading:false}}));
        for (const id of taskIds) if (id.startsWith(`claude:${host.serverId}:`)) reportTask(id, host.name, "disconnected", "无法读取 Claude 状态", false);
        seen.clear();
      } finally {pending.delete(host.serverId);}
    };
    const refresh = () => current.forEach(host => void poll(host));
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("dssh-claude-refresh", refresh);
    return () => {disposed = true; window.clearInterval(timer); window.removeEventListener("dssh-claude-refresh", refresh); taskIds.forEach(removeTask);};
  }, [key]);
  return snapshots;
}
