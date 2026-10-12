import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClaudeHost } from "./claudeStatus";
import type { ProgramStatusKind, ProgramStatusState } from "./programStatus";
import { disconnectTmuxProgramStatus, removeTmuxProgramStatus, syncTmuxProgramStatus } from "./taskStatus";

export interface TmuxProgramPane {
  sessionId: string;
  sessionCreated: number;
  sessionName: string;
  paneId: string;
  windowId: string;
  windowActive: boolean;
  paneActive: boolean;
  state: ProgramStatusState | null;
  kind?: ProgramStatusKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
}

export interface TmuxProgramSnapshot {
  supported: boolean;
  panes: TmuxProgramPane[];
  error: string;
}

const programStates = new Set(["idle", "working", "blocked", "done", "error"]);
const programKinds = new Set(["permission", "question", "auth"]);
const encoder = new TextEncoder();
const plainText = (value: unknown, limit: number): value is string => typeof value === "string" &&
  encoder.encode(value).length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(value);

/** Validate the complete snapshot before applying it: partial data could erase live panes. */
export function parseTmuxProgramSnapshot(value: unknown): Omit<TmuxProgramSnapshot, "error"> {
  const invalid = () => new Error("tmux 程序状态响应无效");
  if (!value || typeof value !== "object") throw invalid();
  const result = value as Record<string, unknown>;
  if (typeof result.supported !== "boolean" || !Array.isArray(result.panes) || (!result.supported && result.panes.length !== 0)) throw invalid();
  const seen = new Set<string>();
  const panes = result.panes.map((entry: unknown): TmuxProgramPane => {
    if (!entry || typeof entry !== "object") throw invalid();
    const pane = entry as Record<string, unknown>;
    if (typeof pane.sessionId !== "string" || !/^\$\d{1,20}$/.test(pane.sessionId) ||
      !Number.isSafeInteger(pane.sessionCreated) || (pane.sessionCreated as number) < 0 ||
      typeof pane.sessionName !== "string" || !pane.sessionName || encoder.encode(pane.sessionName).length > 1024 || pane.sessionName.includes("\0") ||
      typeof pane.paneId !== "string" || !/^%\d{1,20}$/.test(pane.paneId) ||
      typeof pane.windowId !== "string" || !/^@\d{1,20}$/.test(pane.windowId) ||
      typeof pane.windowActive !== "boolean" || typeof pane.paneActive !== "boolean" ||
      (pane.state !== null && (typeof pane.state !== "string" || !programStates.has(pane.state)))) throw invalid();
    const identity = `${pane.sessionId}:${pane.sessionCreated}:${pane.paneId}`;
    if (seen.has(identity)) throw invalid();
    seen.add(identity);
    const normalized: TmuxProgramPane = {
      sessionId: pane.sessionId, sessionCreated: pane.sessionCreated as number, sessionName: pane.sessionName,
      paneId: pane.paneId, windowId: pane.windowId, windowActive: pane.windowActive, paneActive: pane.paneActive,
      state: pane.state as ProgramStatusState | null,
    };
    if (pane.kind != null && pane.kind !== "") {
      if (typeof pane.kind !== "string" || !programKinds.has(pane.kind)) throw invalid();
      if (pane.state === "blocked") normalized.kind = pane.kind as ProgramStatusKind;
    }
    if (pane.progress != null) {
      if (!Number.isInteger(pane.progress) || (pane.progress as number) < 0 || (pane.progress as number) > 100) throw invalid();
      if (pane.state === "working" || pane.state === "blocked") normalized.progress = pane.progress as number;
    }
    if (pane.app != null && pane.app !== "") {
      if (typeof pane.app !== "string" || !/^[A-Za-z0-9_.+-]{1,32}$/.test(pane.app)) throw invalid();
      normalized.app = pane.app;
    }
    for (const key of ["title", "msg"] as const) {
      if (pane[key] == null) continue;
      if (!plainText(pane[key], key === "title" ? 192 : 2048)) throw invalid();
      normalized[key] = pane[key];
    }
    return normalized;
  });
  return { supported: result.supported, panes };
}

interface Monitor {
  host: ClaudeHost;
  disposed: boolean;
  pending: boolean;
  initialized: boolean;
  poll: () => Promise<void>;
}

/** Poll all panes, including ones without status, so focus never sticks to an old pane. */
export function useTmuxProgramStatus(hosts: ClaudeHost[]): Record<string, TmuxProgramSnapshot> {
  const [snapshots, setSnapshots] = useState<Record<string, TmuxProgramSnapshot>>({});
  const monitors = useRef(new Map<string, Monitor>());
  const key = JSON.stringify(hosts);
  useEffect(() => {
    const current = new Map<string, ClaudeHost>((JSON.parse(key) as ClaudeHost[]).map(host => [host.serverId, host]));
    const removed = new Set<string>();
    for (const [serverId, monitor] of monitors.current) {
      const next = current.get(serverId);
      if (next?.sessionId === monitor.host.sessionId && next.name === monitor.host.name) continue;
      monitor.disposed = true;
      monitors.current.delete(serverId);
      // Another live connection to the same server can keep unread results.
      // Its first fresh snapshot restores them without replaying notifications.
      if (next) disconnectTmuxProgramStatus(serverId);
      else removeTmuxProgramStatus(serverId);
      removed.add(serverId);
    }
    if (removed.size) setSnapshots(old => Object.fromEntries(Object.entries(old).filter(([serverId]) => !removed.has(serverId))));
    for (const host of current.values()) {
      if (monitors.current.has(host.serverId)) continue;
      const monitor: Monitor = { host, disposed: false, pending: false, initialized: false, poll: async () => {} };
      monitor.poll = async () => {
        if (monitor.disposed || monitor.pending) return;
        monitor.pending = true;
        try {
          const response = await invoke("tmux_program_status", { sessionId: host.sessionId });
          if (monitor.disposed) return;
          const snapshot = parseTmuxProgramSnapshot(response);
          syncTmuxProgramStatus(host.serverId, host.name, snapshot.panes, monitor.initialized);
          setSnapshots(old => ({ ...old, [host.serverId]: { ...snapshot, error: "" } }));
          monitor.initialized = snapshot.supported;
        } catch (reason) {
          if (monitor.disposed) return;
          monitor.initialized = false;
          disconnectTmuxProgramStatus(host.serverId);
          setSnapshots(old => ({ ...old, [host.serverId]: {
            supported: old[host.serverId]?.supported ?? false,
            panes: old[host.serverId]?.panes ?? [],
            error: `tmux 程序状态未知：${String(reason)}`,
          } }));
        } finally {
          monitor.pending = false;
        }
      };
      monitors.current.set(host.serverId, monitor);
      void monitor.poll();
    }
  }, [key]);

  useEffect(() => {
    const refresh = () => monitors.current.forEach(monitor => void monitor.poll());
    const visible = () => { if (!document.hidden) refresh(); };
    const timer = window.setInterval(refresh, 2500);
    window.addEventListener("dssh-tmux-ps-refresh", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("dssh-tmux-ps-refresh", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visible);
      monitors.current.forEach((monitor, serverId) => {
        monitor.disposed = true;
        removeTmuxProgramStatus(serverId);
      });
      monitors.current.clear();
    };
  }, []);
  return snapshots;
}
