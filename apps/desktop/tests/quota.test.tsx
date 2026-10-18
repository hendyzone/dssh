import { describe, expect, it } from "vitest";
import fixture from "./fixtures/quota.json?raw";
import {
  maskAccount,
  parseChannel,
  parseQuotaReport,
  channelStatus,
  poolsLevel,
  quotaLevel,
  quotaStale,
  scrubReason,
  sharedAccounts,
  toLeftPct,
  windowLabel,
  QUOTA_REFRESH_MS,
} from "../src/lib/quota";

const channel = (report: ReturnType<typeof parseQuotaReport>, name: string) =>
  report.channels.find((c) => c.name === name)!;

describe("toLeftPct", () => {
  it("converts used% to left% and keeps left% as is", () => {
    expect(toLeftPct(7, "used")).toBe(93);
    expect(toLeftPct(80, "left")).toBe(80);
    expect(toLeftPct("43.0", "used")).toBe(57);
    expect(toLeftPct(33.33, "used")).toBe(66.7);
  });
  it("clamps out-of-range values and returns null for missing ones", () => {
    expect(toLeftPct(120, "used")).toBe(0);
    expect(toLeftPct(-5, "left")).toBe(0);
    expect(toLeftPct(null, "used")).toBeNull();
    expect(toLeftPct(undefined, "left")).toBeNull();
    expect(toLeftPct("n/a", "used")).toBeNull();
    expect(toLeftPct("", "used")).toBeNull();
  });
});

describe("quotaLevel", () => {
  it("marks ≤10% red and ≤25% yellow", () => {
    expect(quotaLevel(0)).toBe("danger");
    expect(quotaLevel(10)).toBe("danger");
    expect(quotaLevel(10.1)).toBe("warn");
    expect(quotaLevel(25)).toBe("warn");
    expect(quotaLevel(25.1)).toBe("ok");
    expect(quotaLevel(null)).toBe("unknown");
  });
});

describe("windowLabel", () => {
  it("names the windows each channel reports", () => {
    expect(windowLabel("five_hour")).toEqual({ label: "5 小时", primary: true });
    expect(windowLabel("week")).toEqual({ label: "每周", primary: true });
    expect(windowLabel("win_300m")).toEqual({ label: "5 小时", primary: true });
    expect(windowLabel("7d")).toEqual({ label: "每周", primary: true });
    expect(windowLabel("1d")).toEqual({ label: "1 天", primary: true });
    expect(windowLabel("total")).toEqual({ label: "本周期", primary: true });
    expect(windowLabel("weekly_Fable")).toEqual({ label: "每周 · Fable", primary: false });
    expect(windowLabel("extra[gpt-x]")).toEqual({ label: "gpt-x", primary: false });
    expect(windowLabel("auto").primary).toBe(false);
  });
});

describe("parseQuotaReport", () => {
  const report = parseQuotaReport(fixture);

  it("reads meta and keeps channel order", () => {
    expect(report.host).toBe("example-host");
    expect(report.proxy).toBe("set");
    expect(report.channels.map((c) => c.name)).toEqual([
      "tokenline", "kimi", "deepseek", "claude", "codex", "cursor", "agy",
    ]);
  });

  it("converts used% channels to remaining", () => {
    const claude = parseChannel("claude", {
      ok: true, plan: "max / example_tier", five_hour_pct: 7.0, five_hour_reset: "10-18 09:19",
      seven_day_pct: 93.0, seven_day_reset: "10-22 18:59", weekly_Fable_pct: 0, extra_usage: "off",
    });
    expect(claude.windows.filter((w) => w.primary).map((w) => [w.label, w.leftPct, w.reset])).toEqual([
      ["5 小时", 93, "10-18 09:19"],
      ["每周", 7, "10-22 18:59"],
    ]);
    expect(claude.leftPct).toBe(7);
    expect(claude.level).toBe("danger");
    expect(claude.windows.find((w) => w.id === "weekly_Fable")).toMatchObject({ leftPct: 100, primary: false });
    const kimi = channel(report, "kimi");
    expect(kimi.leftPct).toBe(20);
    expect(kimi.level).toBe("warn");
    expect(kimi.windows.find((w) => w.id === "win_300m")).toMatchObject({ leftPct: null, reset: "10-18 05:38" });
    expect(channel(report, "codex")).toMatchObject({ leftPct: 100, level: "ok" });
    const cursor = channel(report, "cursor");
    expect(cursor.windows.find((w) => w.id === "total")).toMatchObject({ leftPct: 100, reset: "11-01 00:00", primary: true });
    expect(cursor.windows.find((w) => w.id === "api")).toMatchObject({ leftPct: 70, primary: false });
  });

  it("reads agy left% pools without inverting them", () => {
    const agy = channel(report, "agy");
    expect(agy.windows.map((w) => [w.label, w.leftPct, w.reset])).toEqual([
      ["Gemini · 每周", 80, "10-24 03:12"],
      ["Gemini · 5 小时", 100, "10-18 09:34"],
      ["Claude/GPT · 每周", 0, "10-21 06:03"],
    ]);
    expect(agy.leftPct).toBe(0);
    expect(agy.account).toBe("ab…@example.com");
  });

  it("shows balances for channels without a percentage", () => {
    expect(channel(report, "deepseek")).toMatchObject({ leftPct: null, level: "unknown", summary: ["余额 100.00 CNY"] });
    const tokenline = channel(report, "tokenline");
    expect(tokenline.summary).toEqual(["Key 已用 $1,234.5"]);
    expect(tokenline.notes).toContain("账户余额未取到");
  });

  it("keeps FAIL reasons but scrubs accounts, tokens and home paths", () => {
    const fail = channel(report, "claude");
    expect(fail).toMatchObject({ ok: false, code: "token_expired", level: "fail", windows: [] });
    expect(fail.error).toContain("access token 已过期");
    expect(fail.error).not.toContain("user@");
    expect(fail.error).toContain("u…@example.com");
    expect(fail.error).not.toContain("abcdefghijklmnop");
    expect(fail.error).not.toContain("alice");
  });

  it("rejects output that is not quota JSON", () => {
    expect(() => parseQuotaReport("Traceback (most recent call last)")).toThrow("不是 JSON");
    expect(() => parseQuotaReport("{}")).toThrow("channels");
    expect(() => parseQuotaReport({ channels: [] })).toThrow("channels");
    expect(parseQuotaReport({ channels: {} })).toEqual({ host: "", at: "", proxy: "", channels: [] });
  });
});

describe("multi-pool channels (agy)", () => {
  const pool = (name: string, id: string, limit: string, left: number) =>
    ({ pool: name, pool_id: id, limit, left_pct: left, reset: "10-21 06:03" });

  it("groups windows by pools[].pool and only warns when one pool is exhausted", () => {
    const agy = parseChannel("agy", { ok: true, pools: [
      pool("Gemini Models", "gemini", "week", 77), pool("Gemini Models", "gemini", "5h", 88),
      pool("Claude and GPT models", "claude_gpt", "week", 0),
    ] });
    expect(agy.windows.map((w) => w.pool)).toEqual(["Gemini Models", "Gemini Models", "Claude and GPT models"]);
    expect(agy.pools).toEqual([
      { id: "Gemini Models", label: "Gemini", leftPct: 77, level: "ok" },
      { id: "Claude and GPT models", label: "Claude/GPT", leftPct: 0, level: "danger" },
    ]);
    expect(agy.level).toBe("warn");
    expect(channelStatus(agy)).toBe("Gemini 77% · Claude/GPT 0%");
    // Each row is still coloured by its own value.
    expect(agy.windows.map((w) => quotaLevel(w.leftPct))).toEqual(["ok", "ok", "danger"]);
  });

  it("is red when every pool is exhausted", () => {
    const agy = parseChannel("agy", { ok: true, pools: [
      pool("Gemini Models", "gemini", "week", 10), pool("Gemini Models", "gemini", "5h", 60),
      pool("Claude and GPT models", "claude_gpt", "week", 0),
    ] });
    expect(agy.pools?.map((p) => p.leftPct)).toEqual([10, 0]);
    expect(agy.level).toBe("danger");
    expect(channelStatus(agy)).toBe("Gemini 10% · Claude/GPT 0%");
  });

  it("uses the lowest pool when none is exhausted, ignoring pools without data", () => {
    expect(poolsLevel([
      { id: "a", label: "A", leftPct: 20, level: "warn" },
      { id: "b", label: "B", leftPct: 90, level: "ok" },
    ])).toBe("warn");
    expect(poolsLevel([
      { id: "a", label: "A", leftPct: null, level: "unknown" },
      { id: "b", label: "B", leftPct: 5, level: "danger" },
    ])).toBe("danger");
    expect(poolsLevel([{ id: "a", label: "A", leftPct: null, level: "unknown" }])).toBe("unknown");
  });

  it("keeps a single pool on the plain 剩 X% view", () => {
    const agy = parseChannel("agy", { ok: true, pools: [
      pool("Gemini Models", "gemini", "week", 5), pool("Gemini Models", "gemini", "5h", 70),
    ] });
    expect(agy.pools).toBeUndefined();
    expect(agy).toMatchObject({ leftPct: 5, level: "danger" });
    expect(channelStatus(agy)).toBe("剩 5%");
  });

  it("lets limit_reached override the per-pool view", () => {
    const agy = parseChannel("agy", { ok: true, limit_reached: true, pools: [
      pool("Gemini Models", "gemini", "week", 80), pool("Claude and GPT models", "claude_gpt", "week", 50),
    ] });
    expect(agy).toMatchObject({ leftPct: 0, level: "danger" });
    expect(agy.pools).toBeUndefined();
    expect(channelStatus(agy)).toBe("剩 0%");
  });
});

describe("single-pool channels (regression)", () => {
  it("still shows 剩 X% and colours by the lowest primary window", () => {
    const claude = parseChannel("claude", { ok: true, five_hour_pct: 80, seven_day_pct: 5 });
    expect(claude.pools).toBeUndefined();
    expect(claude).toMatchObject({ leftPct: 20, level: "warn" });
    expect(channelStatus(claude)).toBe("剩 20%");
    const red = parseChannel("codex", { ok: true, "5h_used_pct": 95, "7d_used_pct": 10 });
    expect(red).toMatchObject({ leftPct: 5, level: "danger" });
    expect(channelStatus(red)).toBe("剩 5%");
    expect(channelStatus(parseChannel("deepseek", { ok: true, balance: "1 CNY" }))).toBe("OK");
    expect(channelStatus(parseChannel("x", { ok: false, error: "e" }))).toBe("FAIL");
  });
});

describe("parseChannel edge cases", () => {
  it("tolerates missing fields", () => {
    expect(parseChannel("x", { ok: true })).toMatchObject({ ok: true, windows: [], summary: [], leftPct: null, level: "unknown" });
    expect(parseChannel("x", { ok: false })).toMatchObject({ ok: false, error: "未给出原因", level: "fail" });
    expect(parseChannel("x", "junk")).toMatchObject({ ok: false, level: "fail" });
    expect(parseChannel("x", null)).toMatchObject({ ok: false, level: "fail" });
    expect(parseChannel("agy", { ok: true, pools: [null, { left_pct: "oops" }] }).windows).toEqual([
      { id: "pool0:0", label: "pool0", leftPct: null, reset: undefined, primary: true, pool: undefined },
    ]);
  });
  it("flags hard limits and stale fallbacks", () => {
    expect(parseChannel("codex", { ok: true, limit_reached: true, "5h_used_pct": 40 })).toMatchObject({
      leftPct: 0, level: "danger", notes: ["已触顶"],
    });
    const stale = parseChannel("codex", { ok: true, source: "本地会话日志", STALE: true, primary_used_pct: 50, primary_reset: "10-18 01:00" });
    expect(stale.windows[0]).toMatchObject({ label: "主窗口", leftPct: 50 });
    expect(stale.notes[0]).toContain("过重置点");
    expect(parseChannel("deepseek", { ok: true, available: false }).level).toBe("danger");
  });
});

describe("maskAccount / scrubReason", () => {
  it("masks accounts", () => {
    expect(maskAccount("alice@example.com")).toBe("a…@example.com");
    expect(maskAccount("ab…@example.com")).toBe("a…@example.com");
    expect(maskAccount("abcdef")).toBe("ab…");
    expect(maskAccount("abc")).toBe("…");
  });
  it("scrubs long tokens and limits length", () => {
    expect(scrubReason("key sk-ABCDEFGHIJKLMNOP")).toBe("key sk-***");
    expect(scrubReason("jwt eyJhbGciOiJIUzI1NiJ9.x")).toBe("jwt eyJ***");
    expect(scrubReason("x".repeat(500))).toHaveLength(3);
    expect(scrubReason("y ".repeat(300)).length).toBe(200);
  });
});

describe("sharedAccounts", () => {
  it("links the same account across servers and ignores unique or missing ones", () => {
    const report = (account?: string) => parseQuotaReport({ channels: { agy: { ok: true, account, pools: [] }, kimi: { ok: true } } });
    const shared = sharedAccounts([
      { server: "s1", name: "server-a", report: report("ab…@example.com") },
      { server: "s2", name: "server-b", report: report("ab…@example.com") },
      { server: "s3", name: "server-c", report: report("zz…@example.com") },
      { server: "s4", name: "server-d", report: report(undefined) },
    ]);
    expect(shared.get("s1/agy")).toEqual(["server-b · agy"]);
    expect(shared.get("s2/agy")).toEqual(["server-a · agy"]);
    expect(shared.has("s3/agy")).toBe(false);
    expect(shared.has("s4/agy")).toBe(false);
    expect(shared.has("s1/kimi")).toBe(false);
  });
  it("does not treat failed channels as shared", () => {
    const ok = parseQuotaReport({ channels: { agy: { ok: true, account: "a@x.com" } } });
    const failed = parseQuotaReport({ channels: { agy: { ok: false, account: "a@x.com", error: "e" } } });
    expect(sharedAccounts([{ server: "a", report: ok }, { server: "b", report: failed }]).size).toBe(0);
  });
});

describe("quotaStale", () => {
  it("refreshes only after five minutes", () => {
    expect(quotaStale(undefined, 0)).toBe(true);
    expect(quotaStale(1000, 1000 + QUOTA_REFRESH_MS - 1)).toBe(false);
    expect(quotaStale(1000, 1000 + QUOTA_REFRESH_MS)).toBe(true);
  });
});
