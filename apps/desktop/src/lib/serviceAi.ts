/** Presentation allowlist; transport identifiers and credentials never enter the room. */
export interface ServiceAi {
  status: "working" | "waiting" | "idle" | "unknown";
  summary: string;
  evidence: string;
  model: string;
  updatedAt: string;
  /** 当前 status+summary 从何时起成立；旧服务端没有该字段时用 updatedAt 回退。 */
  since?: string;
}
export function serviceAi(value: unknown): ServiceAi | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (!["working", "waiting", "idle", "unknown"].includes(String(v.status)) ||
      typeof v.summary !== "string" || v.summary.length > 80 ||
      typeof v.evidence !== "string" || v.evidence.length > 600 ||
      typeof v.model !== "string" || !v.model || v.model.length > 128 ||
      typeof v.updatedAt !== "string" || !Number.isFinite(Date.parse(v.updatedAt))) return;
  const since = typeof v.since === "string" && Number.isFinite(Date.parse(v.since)) ? v.since : undefined;
  return { status: v.status as ServiceAi["status"], summary: v.summary,
    evidence: v.evidence, model: v.model, updatedAt: v.updatedAt, ...(since ? {since} : {}) };
}
