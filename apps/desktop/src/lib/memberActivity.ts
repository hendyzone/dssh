import { ago, type LiveStatus, type LiveTone } from "./agentSessions";

/** Team service live `activity` (protocol §6.4): the agent's own assessment or a service-derived state. */
export type ActivityState = "working" | "stalled" | "waiting_human" | "idle" | "unattached" | "offline" | "unknown";
export interface ServiceActivity {
  state: ActivityState;
  reason?: string;
  since?: string;
  source?: "events" | "process" | "pane";
  last_event?: string | null;
  open_tool?: string | null;
}
const STATES = new Set<ActivityState>(["working", "stalled", "waiting_human", "idle", "unattached", "offline", "unknown"]);

/** Untrusted wire value → activity, or undefined when absent / malformed (older services send none). */
export function parseActivity(value: unknown): ServiceActivity | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!STATES.has(v.state as ActivityState)) return undefined;
  const text = (x: unknown, n: number) => typeof x === "string" ? x.slice(0, n) : undefined;
  const since = text(v.since, 40);
  const source = ["events", "process", "pane"].includes(String(v.source)) ? v.source as ServiceActivity["source"] : undefined;
  return {
    state: v.state as ActivityState,
    ...(text(v.reason, 200) ? { reason: text(v.reason, 200) } : {}),
    ...(since && Number.isFinite(Date.parse(since)) ? { since } : {}),
    ...(source ? { source } : {}),
    ...(typeof v.open_tool === "string" ? { open_tool: v.open_tool.slice(0, 64) } : {}),
  };
}

/** Icon + word for every state the panel shows itself; colour is never the only cue. */
export const ACTIVITY_VIEW: Record<"working" | "stalled" | "waiting_human" | "idle" | "offline", { icon: string; label: string; tone: LiveTone }> = {
  working: { icon: "▶", label: "干活中", tone: "run" },
  waiting_human: { icon: "✋", label: "等人", tone: "wait" },
  stalled: { icon: "⚠", label: "疑似卡住", tone: "bad" },
  idle: { icon: "⏸", label: "空闲", tone: "idle" },
  offline: { icon: "⊘", label: "离线", tone: "offline" },
};
export type ShownActivity = keyof typeof ACTIVITY_VIEW;

/** unknown / unattached / missing fall back to the existing pane status (old services, boxes without hooks). */
export function shownActivity(activity: ServiceActivity | undefined): ShownActivity | undefined {
  const state = activity?.state;
  return state && state in ACTIVITY_VIEW ? state as ShownActivity : undefined;
}

const SOURCE_HINT = { events: "", process: "据进程推断", pane: "据面板推断" } as const;

/** A card counts as 「有卡未动」 only after the session has been idle this long (user, dssh/T93): a box that just
 * delivered has a few minutes to move its card before it is flagged. */
export const CARD_IDLE_ALERT_SECONDS = 10 * 60;

/**
 * The member's activity as a panel status. The three combinations someone should look at first are
 * ranked to the top and marked as needing a human: waiting for a person, a card with a stalled
 * session, and a card whose session sits idle (delivered but not moved, or quietly stuck).
 */
export function activityStatus(activity: ServiceActivity, hasCard: boolean, now: number, lead = false): LiveStatus | undefined {
  const shown = shownActivity(activity);
  if (!shown) return undefined;
  const view = ACTIVITY_VIEW[shown];
  const since = activity.since ? Date.parse(activity.since) / 1000 : 0;
  const duration = since > 0 ? ago(since, now) : "";
  const title = [activity.reason, activity.source ? SOURCE_HINT[activity.source] : ""].filter(Boolean).join(" · ") || undefined;
  const label = `${view.icon} ${view.label}`;
  if (lead) return { rank: -1, tone: view.tone, group: "lead", label, needsHuman: false, duration, title };
  switch (shown) {
    case "waiting_human":
      return { rank: 1, tone: view.tone, group: "attention", label, needsHuman: true, duration, title };
    case "stalled":
      return { rank: hasCard ? 0 : 2, tone: view.tone, group: "attention", label, needsHuman: true, duration, title };
    case "idle":
      return hasCard && since > 0 && now - since >= CARD_IDLE_ALERT_SECONDS
        ? { rank: 3, tone: "warn", group: "attention", label: `${label} · 有卡未动`, needsHuman: true, duration, title: [title, "有进行中的卡，但会话空闲：交付后忘了移卡，或卡住了没表现出来"].filter(Boolean).join(" · ") }
        : { rank: 7, tone: view.tone, group: "available", label, needsHuman: false, duration, title };
    case "working":
      return { rank: 6, tone: view.tone, group: "running", label, needsHuman: false, duration, title };
    case "offline":
      return { rank: 8, tone: view.tone, group: "other", label, needsHuman: false, duration, title };
  }
}

/** AI summaries older than this are greyed and marked 「旧」(plan §3.4). */
export const AI_STALE_MS = 30 * 60_000;
export function aiIsOld(ai: { since?: string; updatedAt?: string } | undefined, nowMs: number): boolean {
  const at = Date.parse(ai?.since ?? ai?.updatedAt ?? "");
  return Number.isFinite(at) && nowMs - at > AI_STALE_MS;
}
