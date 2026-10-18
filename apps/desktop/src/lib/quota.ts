/**
 * Model quota parsing for the 额度 panel.
 *
 * Input is the JSON printed by `tools/model-quota/model-quota.py --json` (bundled with dssh and
 * streamed to the server): `{meta, channels:{name:{ok,…}}}`.
 * Channels report differently: most give *used* percentages (`five_hour_pct`,
 * `week_used_pct`, `7d_used_pct`, `total_pct`…), agy gives *left* percentages in a
 * `pools` array. Everything here is converted to "剩余%" so the panel reads one way.
 */

export type QuotaLevel = "ok" | "warn" | "danger" | "unknown" | "fail";

export interface QuotaWindow {
  id: string;
  label: string;
  /** Remaining percentage 0–100, or null when the server did not report one. */
  leftPct: number | null;
  reset?: string;
  /** Main windows (5 小时 / 每周 / 本周期) get a bar; the rest are shown compactly. */
  primary: boolean;
}

export interface QuotaChannel {
  name: string;
  ok: boolean;
  plan?: string;
  /** FAIL reason, already scrubbed of accounts and tokens. */
  error?: string;
  /** Machine-readable FAIL code from the script (`no_credentials`, `token_expired`, …). */
  code?: string;
  windows: QuotaWindow[];
  /** Balance-style figures for channels without a percentage (deepseek, tokenline…). */
  summary: string[];
  notes: string[];
  /** Raw account identifier used for same-account matching; display via maskAccount. */
  account?: string;
  /** Lowest remaining percentage over the primary windows. */
  leftPct: number | null;
  level: QuotaLevel;
}

export interface QuotaReport {
  host: string;
  at: string;
  proxy: string;
  /** `set` / `none` when the script reports whether the tokenline relay address is configured. */
  tokenlineBase?: string;
  channels: QuotaChannel[];
}

export const QUOTA_REFRESH_MS = 5 * 60 * 1000;
export const DANGER_LEFT = 10;
export const WARN_LEFT = 25;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) =>
  typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;

function percent(value: unknown): number | null {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isFinite(number)) return null;
  return Math.min(100, Math.max(0, number));
}

/** Convert a reported percentage to 剩余%, clamped to 0–100; null when missing. */
export function toLeftPct(value: unknown, kind: "used" | "left"): number | null {
  const pct = percent(value);
  if (pct === null) return null;
  return Math.round((kind === "used" ? 100 - pct : pct) * 10) / 10;
}

/** ≤10% 剩余标红，≤25% 标黄。 */
export function quotaLevel(leftPct: number | null): QuotaLevel {
  if (leftPct === null) return "unknown";
  if (leftPct <= DANGER_LEFT) return "danger";
  if (leftPct <= WARN_LEFT) return "warn";
  return "ok";
}

/** Keep the first character of the local part and the domain: `a…@example.com`. */
export function maskAccount(account: string): string {
  const value = account.trim();
  const at = value.lastIndexOf("@");
  if (at > 0) return `${value[0]}…${value.slice(at)}`;
  if (value.length <= 4) return "…";
  return `${value.slice(0, 2)}…`;
}

/** Remove things that must not reach the screen from a FAIL reason. */
export function scrubReason(reason: string): string {
  return reason
    .replace(/[\w.+-]*…?@[\w-]+(?:\.[\w-]+)+/g, (match) => maskAccount(match))
    .replace(/(sk-|eyJ|Bearer\s+)[A-Za-z0-9._-]{8,}/g, "$1***")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "***")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "~")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 200);
}

const PRIMARY = new Set(["five_hour", "seven_day", "week", "5h", "7d", "primary", "total"]);
const NAMED: Record<string, string> = {
  five_hour: "5 小时",
  seven_day: "每周",
  week: "每周",
  primary: "主窗口",
  total: "本周期",
  auto: "Auto",
  api: "API",
  seven_day_opus: "每周 · Opus",
  seven_day_sonnet: "每周 · Sonnet",
};

function spanLabel(amount: number, unit: string): string {
  if (unit === "m") return amount % 60 === 0 ? spanLabel(amount / 60, "h") : `${amount} 分钟`;
  if (unit === "h") return amount % 24 === 0 ? spanLabel(amount / 24, "d") : `${amount} 小时`;
  return amount === 7 ? "每周" : `${amount} 天`;
}

/** Human label for a `<prefix>_pct` / `<prefix>_used_pct` field prefix. */
export function windowLabel(prefix: string): { label: string; primary: boolean } {
  if (NAMED[prefix]) return { label: NAMED[prefix], primary: PRIMARY.has(prefix) };
  const span = /^(?:win_)?(\d+)([mhd])$/.exec(prefix);
  if (span) return { label: spanLabel(Number(span[1]), span[2]), primary: true };
  const weekly = /^weekly_(.+)$/.exec(prefix);
  if (weekly) return { label: `每周 · ${weekly[1]}`, primary: false };
  const extra = /^extra\[(.+)\]$/.exec(prefix);
  if (extra) return { label: extra[1], primary: false };
  return { label: prefix, primary: false };
}

const AGY_POOLS: Record<string, string> = { gemini: "Gemini", claude_gpt: "Claude/GPT" };
const AGY_LIMITS: Record<string, string> = { "5h": "5 小时", week: "每周" };

function agyWindows(pools: unknown): QuotaWindow[] {
  if (!Array.isArray(pools)) return [];
  return pools.filter(isObject).map((pool, index) => {
    const poolId = text(pool.pool_id) ?? text(pool.pool) ?? `pool${index}`;
    const limit = text(pool.limit) ?? "";
    return {
      id: `${poolId}:${limit || index}`,
      label: [AGY_POOLS[poolId] ?? text(pool.pool) ?? poolId, AGY_LIMITS[limit] ?? limit].filter(Boolean).join(" · "),
      leftPct: toLeftPct(pool.left_pct, "left"),
      reset: text(pool.reset),
      primary: true,
    };
  });
}

function usedWindows(raw: Record<string, unknown>): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const match = /^(.+?)(_used)?_pct$/.exec(key);
    if (!match || key.startsWith("lowest_") || key.endsWith("left_pct")) continue;
    const prefix = match[1];
    const { label, primary } = windowLabel(prefix);
    windows.push({
      id: prefix,
      label,
      leftPct: toLeftPct(value, "used"),
      reset: text(raw[`${prefix}_reset`]) ?? (prefix === "total" ? text(raw.cycle_end) : undefined),
      primary,
    });
  }
  return windows;
}

const money = (value: unknown) => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US", { maximumFractionDigits: 2 }) : text(value);
};

function balanceSummary(raw: Record<string, unknown>): string[] {
  const summary: string[] = [];
  if (raw.balance !== undefined) summary.push(`余额 ${text(raw.balance)}`);
  if (raw.balance_usd !== undefined) summary.push(`余额 $${money(raw.balance_usd)}`);
  if (raw.key_remaining_usd !== undefined) summary.push(`Key 剩余 $${money(raw.key_remaining_usd)}`);
  else if (raw.key_used_usd !== undefined) summary.push(`Key 已用 $${money(raw.key_used_usd)}`);
  if (raw.credits !== undefined && raw.credits !== null) summary.push(`credits ${money(raw.credits)}`);
  const included = text(raw["included_used/limit"]);
  if (included) summary.push(`已用 ${included}`);
  return summary;
}

/** Normalize one channel object from the quota script. Never throws. */
export function parseChannel(name: string, raw: unknown): QuotaChannel {
  const base = { name, windows: [] as QuotaWindow[], summary: [] as string[], notes: [] as string[], leftPct: null };
  if (!isObject(raw)) return { ...base, ok: false, error: "返回格式无效", level: "fail" };
  if (raw.ok !== true) {
    const reason = text(raw.error);
    const code = text(raw.code);
    return {
      ...base,
      ok: false,
      error: reason ? scrubReason(reason) : "未给出原因",
      ...(code && /^[a-z0-9_]{1,40}$/.test(code) ? { code } : {}),
      level: "fail",
    };
  }
  const windows = Array.isArray(raw.pools) ? agyWindows(raw.pools) : usedWindows(raw);
  const notes: string[] = [];
  if (raw.STALE === true) notes.push("数据已过重置点，仅供参考");
  if (raw.source !== undefined) notes.push(`来源：${text(raw.source)}（实时接口未取到）`);
  if (raw.extra_usage === "on") notes.push("超额用量已开");
  if (raw.on_demand === "on") notes.push("按需付费已开");
  if (raw.account_error !== undefined) notes.push("账户余额未取到");
  const known = windows.filter((w) => w.primary && w.leftPct !== null).map((w) => w.leftPct as number);
  let leftPct = known.length ? Math.min(...known) : null;
  let level = quotaLevel(leftPct);
  if (raw.limit_reached === true) {
    notes.unshift("已触顶");
    leftPct = 0;
    level = "danger";
  }
  if (raw.available === false) {
    notes.unshift("账户不可用");
    level = "danger";
  }
  const account = text(raw.account)?.trim();
  return {
    ...base,
    ok: true,
    plan: text(raw.plan),
    windows,
    summary: balanceSummary(raw),
    notes,
    account: account || undefined,
    leftPct,
    level,
  };
}

/** Parse the full quota script JSON. Throws a user-facing message when the shape is wrong. */
export function parseQuotaReport(input: string | unknown): QuotaReport {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("额度脚本输出不是 JSON");
    }
  }
  if (!isObject(value) || !isObject(value.channels)) throw new Error("额度脚本输出缺少 channels");
  const meta = isObject(value.meta) ? value.meta : {};
  return {
    host: text(meta.host) ?? "",
    at: text(meta.at) ?? "",
    proxy: text(meta.proxy) ?? "",
    tokenlineBase: text(meta.tokenline_base),
    channels: Object.entries(value.channels).map(([name, raw]) => parseChannel(name, raw)),
  };
}

export interface ServerQuota {
  /** Unique key of the server (its id). */
  server: string;
  /** Display name used in the 「与 X 共用」 hint; defaults to `server`. */
  name?: string;
  report: QuotaReport;
}

/**
 * For every `server/channel` whose account is also seen elsewhere, list the others.
 * Quota follows the account, so the same account on two machines is one pool.
 */
export function sharedAccounts(reports: ServerQuota[]): Map<string, string[]> {
  const byAccount = new Map<string, { key: string; label: string }[]>();
  for (const { server, name, report } of reports) {
    for (const channel of report.channels) {
      if (!channel.ok || !channel.account) continue;
      const list = byAccount.get(channel.account) ?? [];
      list.push({ key: `${server}/${channel.name}`, label: `${name ?? server} · ${channel.name}` });
      byAccount.set(channel.account, list);
    }
  }
  const result = new Map<string, string[]>();
  for (const list of byAccount.values()) {
    if (list.length < 2) continue;
    for (const entry of list) {
      result.set(entry.key, list.filter((other) => other.key !== entry.key).map((other) => other.label));
    }
  }
  return result;
}

/** Whether a cached result is old enough to fetch again. */
export function quotaStale(fetchedAt: number | undefined, now: number, interval = QUOTA_REFRESH_MS): boolean {
  return fetchedAt === undefined || now - fetchedAt >= interval;
}
