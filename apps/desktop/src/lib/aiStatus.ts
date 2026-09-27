import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { reportTask, removeTask } from "./taskStatus";
import type { ClaudeHost } from "./claudeStatus";
import type { SessionInfo } from "../types";

export const aiProviders = { claude: "Claude", codex: "Codex", pi: "pi" } as const;
export type AiProvider = keyof typeof aiProviders;
export type AiPhase = "ready" | "working" | "waiting" | "idle" | "error" | "stopped";
export interface AiTask {
  id: string;
  provider: AiProvider;
  phase: AiPhase;
  updated: number;
  revision: string;
  paneId?: string;
  connectionId?: string;
  tmux?: { id: string; created: number; name: string; pane: string };
  active?: boolean;
}
export const aiPhaseLabels: Record<AiPhase, string> = {
  ready: "等待输入", working: "处理中", waiting: "需要确认或输入",
  idle: "本轮已结束", error: "工具报告错误", stopped: "工具已退出",
};
export const aiTaskId = (serverId: string, id: string) => `ai:${serverId}:${id}`;
interface Snapshot { tasks: AiTask[]; error: string }

export function parseAiTasks(value: unknown): AiTask[] {
  if (!Array.isArray(value)) throw new Error("AI 状态响应无效");
  return value.filter((item): item is AiTask => {
    if (!item || typeof item !== "object") return false;
    if (typeof item.id !== "string" || !/^[a-f0-9]{64}$/.test(item.id) ||
        !Object.hasOwn(aiProviders, item.provider) || !Object.hasOwn(aiPhaseLabels, item.phase) ||
        !Number.isSafeInteger(item.updated) || typeof item.revision !== "string") return false;
    if (item.tmux) return typeof item.tmux.id === "string" && /^\$\d+$/.test(item.tmux.id) &&
      Number.isSafeInteger(item.tmux.created) && typeof item.tmux.name === "string" &&
      typeof item.tmux.pane === "string" && /^%\d+$/.test(item.tmux.pane);
    return typeof item.paneId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(item.paneId) &&
      typeof item.connectionId === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(item.connectionId);
  });
}

/** One bounded request per connected server; first snapshot never replays old alerts. */
export function useAiStatus(hosts: ClaudeHost[], panes?: SessionInfo[], backendIds?: Record<string, string | null>) {
  const [snapshots, setSnapshots] = useState<Record<string, Snapshot>>({});
  const known = useRef(new Map<string, string>());
  const key = JSON.stringify({ hosts, panes: panes?.map(p => ({ id: p.id, serverId: p.server.id, tmux: p.tmux, backendId: backendIds?.[p.id] })) });
  useEffect(() => {
    const input: { hosts: ClaudeHost[]; panes?: { id: string; serverId: string; backendId?: string; tmux?: SessionInfo["tmux"] }[] } = JSON.parse(key);
    const current = input.hosts;
    let disposed = false;
    const pending = new Set<string>();
    const initialized = new Set<string>();
    const ids = new Map<string, Set<string>>();
    const poll = async (host: ClaudeHost) => {
      if (pending.has(host.serverId)) return;
      pending.add(host.serverId);
      try {
        const tasks = parseAiTasks(await invoke("ai_status", { sessionId: host.sessionId }))
          .filter(task => task.tmux || !input.panes || input.panes.some(p => p.id === task.paneId && p.serverId === host.serverId && p.backendId === task.connectionId));
        if (disposed) return;
        setSnapshots(old => ({ ...old, [host.serverId]: { tasks, error: "" } }));
        const next = new Set<string>();
        for (const task of tasks) {
          const id = aiTaskId(host.serverId, task.id);
          next.add(id);
          const sourcePaneId = task.paneId ?? (task.active ? input.panes?.find(p => p.serverId === host.serverId &&
            p.tmux?.id === task.tmux?.id && p.tmux?.created === task.tmux?.created)?.id : undefined);
          const signature = `${task.revision}|${sourcePaneId ?? ""}`;
          const changed = known.current.get(id)?.split("|")[0] !== task.revision;
          if (known.current.get(id) === signature && initialized.has(host.serverId) && ids.get(host.serverId)?.has(id)) continue;
          reportTask(id, `${host.name} · ${aiProviders[task.provider]}${task.tmux ? " · " + task.tmux.name + " " + task.tmux.pane : ""}`,
            task.phase, aiPhaseLabels[task.phase], false, initialized.has(host.serverId) && changed,
            task.updated, { provider: task.provider, sourcePaneId });
          known.current.set(id, signature);
        }
        for (const id of ids.get(host.serverId) ?? []) if (!next.has(id)) { removeTask(id); known.current.delete(id); }
        ids.set(host.serverId, next);
        initialized.add(host.serverId);
      } catch (error) {
        if (disposed) return;
        setSnapshots(old => ({ ...old, [host.serverId]: { tasks: old[host.serverId]?.tasks ?? [], error: `AI 状态未知：${String(error)}` } }));
        for (const id of ids.get(host.serverId) ?? [])
          reportTask(id, host.name, "disconnected", "无法读取 AI 状态", false, initialized.has(host.serverId));
        initialized.delete(host.serverId); // Reconnection must not replay old completion events.
      } finally { pending.delete(host.serverId); }
    };
    const refresh = () => current.forEach(host => void poll(host));
    refresh();
    const timer = window.setInterval(refresh, 2500);
    window.addEventListener("dssh-ai-refresh", refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("dssh-ai-refresh", refresh);
      ids.forEach(set => set.forEach(id => { removeTask(id); known.current.delete(id); }));
    };
  }, [key]);
  return snapshots;
}
