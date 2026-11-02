import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CollaborationProfile } from "./collaboration";
import type { TeamMember } from "./teamMembers";
import type { LiveSessions } from "./agentSessions";
import type { TeamLive } from "./teamService";

/** Presentation-only allowlist, mirroring OfficeSnapshot: never send credentials. */
export interface TeamWindowSnapshot {
  version: 1;
  themeId: string;
  sessionId: string;
  profile: CollaborationProfile;
  members: TeamMember[];
  live: Pick<LiveSessions, "tasks" | "taskProjects" | "parentBy" | "briefs" | "statusNames" | "offline" | "error" | "snapshot">;
  serviceLive: Record<string, TeamLive>;
  serviceAi: Record<string, unknown>;
  aiEnabled?: boolean | null;
  serviceIdentity: string;
  /** Never passwords/keys/auth fields. */
  servers: { id: string; name: string; host: string; port: number; username: string }[];
}
export type TeamWindowAction =
  | { kind: "open_member"; key: string }
  | { kind: "open_task"; project: string; code: string }
  | { kind: "refresh" };

export interface TeamWindowEnvelope { epoch: string; sequence: number; snapshot: TeamWindowSnapshot; }
interface TeamWindowInitial { snapshot: TeamWindowEnvelope | null; }
const teamTarget = { kind: "WebviewWindow" as const, label: "team" };
const mainTarget = { kind: "WebviewWindow" as const, label: "main" };
// Survives StrictMode effect replacement: an older in-flight IPC finishes before a new publisher.
let publicationTail: Promise<void> = Promise.resolve();

export function openTeamWindow(): Promise<void> { return invoke("open_team_window"); }

const RESTORE_KEY = "dssh.team-window.open.v1";
/** Set while the window is open, cleared when the user closes it; read once at startup. */
function markTeamWindowOpen(open: boolean) {
  try { if (open) localStorage.setItem(RESTORE_KEY, "1"); else localStorage.removeItem(RESTORE_KEY); } catch { /* best effort */ }
}
export function shouldRestoreTeamWindow(): boolean {
  try { return localStorage.getItem(RESTORE_KEY) === "1"; } catch { return false; }
}
let restoreAttempted = false;
/** At most once per app launch: reopen the team window if it was left open last session. */
export function restoreTeamWindowOnce() {
  if (restoreAttempted) return;
  restoreAttempted = true;
  if (shouldRestoreTeamWindow()) void openTeamWindow().catch(error => console.error("Team window restore failed", error));
}

/** Content deduplication and one trailing update per 250ms, only while the popup exists. */
export function useTeamWindowPublisher(snapshot: TeamWindowSnapshot, teamExists = false) {
  const content = teamExists ? JSON.stringify(snapshot) : "";
  const latest = useRef({snapshot, content, teamExists});
  latest.current = {snapshot, content, teamExists};
  const request = useRef<(() => void) | undefined>();
  const lastSent = useRef<string>();
  const cycle = useRef(0);
  const cancelTimer = useRef<(() => void) | undefined>();
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    const schedule = () => {
      if (disposed || !latest.current.teamExists || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const send = async () => {
          if (disposed || !latest.current.teamExists || lastSent.current === latest.current.content) return;
          const next = latest.current;
          const generation = cycle.current;
          await invoke<void>("team_publish_snapshot", {snapshot:next.snapshot});
          if (!disposed && latest.current.teamExists && generation === cycle.current) lastSent.current = next.content;
        };
        const work = publicationTail.then(send, send);
        publicationTail = work.catch(error => console.error("Team snapshot publish failed", error));
      }, 250);
    };
    request.current = schedule;
    cancelTimer.current = () => { if(timer !== undefined) clearTimeout(timer); timer = undefined; };
    void listen("team:request", () => { schedule(); }, {target:mainTarget}).then(unlisten => {
      if (disposed) unlisten(); else { off = unlisten; schedule(); }
    }).catch(error => console.error("Team request listener failed", error));
    schedule();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); off?.(); request.current = undefined; };
  }, []);
  useEffect(() => {
    if (!teamExists) { cycle.current++; lastSent.current = undefined; cancelTimer.current?.(); }
    request.current?.();
  }, [content, teamExists]);
}

/** Presence is native lifecycle state, independent of the child React startup. */
export function useTeamWindowPresence() {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let disposed = false, received = false;
    let off: (() => void) | undefined;
    void listen<boolean>("team:presence", event => {
      if (!disposed) { received = true; setExists(event.payload); markTeamWindowOpen(event.payload); }
    }, {target:mainTarget}).then(async unlisten => {
      if (disposed) { unlisten(); return; }
      off = unlisten;
      const initial = await invoke<boolean>("team_window_exists");
      if (!disposed && !received) setExists(initial);
    }).catch(error => console.error("Team presence unavailable", error));
    return () => { disposed = true; off?.(); };
  }, []);
  return exists;
}

/** Subscribe before pulling the cache; a newer broadcast must beat a delayed initial reply. */
export function useTeamWindowSnapshot() {
  const [snapshot, setSnapshot] = useState<TeamWindowSnapshot>();
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let current: TeamWindowEnvelope | undefined;
    const receive = (next: TeamWindowEnvelope | null) => {
      if (disposed || !next || next.snapshot?.version !== 1 || !Number.isSafeInteger(next.sequence) || next.sequence < 1) return;
      // A team window belongs to one native process; another epoch is never authoritative.
      if (current && (next.epoch !== current.epoch || next.sequence <= current.sequence)) return;
      current = next;
      setSnapshot(next.snapshot);
      setError("");
    };
    let off: (() => void) | undefined;
    void (async () => {
      const unlisten = await listen<TeamWindowEnvelope>("team:snapshot", event => receive(event.payload), { target: teamTarget });
      if (disposed) { unlisten(); return; }
      off = unlisten;
      const initial = await invoke<TeamWindowInitial>("team_request_snapshot");
      if (disposed) return;
      receive(initial.snapshot);
    })().catch(reason => { if (!disposed) setError(`团队同步失败：${String(reason)}`); });
    return () => { disposed = true; off?.(); };
  }, []);
  return { snapshot, error };
}

export function sendTeamWindowAction(action: TeamWindowAction): Promise<void> {
  return invoke("team_window_action", {action});
}

/** Main-side action routing: registered once, always dispatching to the latest handler. */
export function useTeamWindowActions(handler: (action: TeamWindowAction) => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    let disposed = false;
    let off: (() => void) | undefined;
    void listen<TeamWindowAction>("team:action", event => { if (!disposed) handlerRef.current(event.payload); }, {target:mainTarget})
      .then(unlisten => { if (disposed) unlisten(); else off = unlisten; })
      .catch(error => console.error("Team action listener failed", error));
    return () => { disposed = true; off?.(); };
  }, []);
}
