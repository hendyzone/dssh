import { describe, expect, it } from "vitest";
import fixture from "./fixtures/quota.json?raw";
import { parseChannel, parseQuotaReport } from "../src/lib/quota";
import { failureCode, quotaIssues, quotaPrompt, QUOTA_CONFIG, QUOTA_SCRIPT_URL } from "../src/lib/quotaPrompt";

const report = (proxy: string, channels: Record<string, unknown>) =>
  parseQuotaReport({ meta: { host: "box", proxy, at: "t" }, channels });
const ok = { ok: true, five_hour_pct: 10 };
const fail = (code: string | undefined, error: string) => ({ ok: false, error, ...(code ? { code } : {}) });
const kinds = (input: Parameters<typeof quotaIssues>[0]) => quotaIssues(input).map((i) => [i.kind, i.channels]);

describe("failureCode", () => {
  it("uses the script's code and infers one for older output", () => {
    expect(failureCode(parseChannel("x", fail("token_expired", "whatever")))).toBe("token_expired");
    expect(failureCode(parseChannel("x", fail(undefined, "本机无凭据: auth.json")))).toBe("no_credentials");
    expect(failureCode(parseChannel("x", fail(undefined, "凭据缺字段/未配置: 'deepseek'")))).toBe("missing_field");
    expect(failureCode(parseChannel("x", fail(undefined, "access token 已过期，跑一次 claude")))).toBe("token_expired");
    expect(failureCode(parseChannel("x", fail(undefined, "<urlopen error timed out>  (未设代理)")))).toBe("timeout");
    expect(failureCode(parseChannel("x", fail(undefined, "HTTP 401: nope")))).toBe("http_401");
    expect(failureCode(parseChannel("x", fail(undefined, "本机未装 agy")))).toBe("not_installed");
    expect(failureCode(parseChannel("x", fail(undefined, "boom")))).toBe("error");
  });
});

describe("quotaIssues", () => {
  it("is empty when every channel is OK", () => {
    expect(quotaIssues({ state: "ok", report: report("set", { claude: ok, codex: ok }) })).toEqual([]);
  });

  it("blames the missing proxy for network failures, and the proxy itself when one is set", () => {
    const channels = { claude: fail("network", "<urlopen error unreachable>"), codex: fail("http_403", "HTTP 403"), kimi: ok };
    expect(kinds({ state: "ok", report: report("none", channels) })).toEqual([["proxy", ["claude", "codex"]]]);
    expect(kinds({ state: "ok", report: report("set", channels) })).toEqual([["unreachable", ["claude", "codex"]]]);
  });

  it("groups mixed failures, most important first", () => {
    const issues = quotaIssues({ state: "ok", report: report("none", {
      tokenline: fail("not_configured", "未配置 tokenline_base"),
      claude: fail("token_expired", "access token 已过期"),
      cursor: fail("no_credentials", "本机无凭据: auth.json"),
      deepseek: fail("missing_field", "凭据缺字段/未配置: 'deepseek'"),
      agy: fail("not_installed", "本机未装 agy"),
      codex: fail("timeout", "超时"),
      kimi: fail("http_401", "HTTP 401: invalid"),
      "pi-codex": fail("error", "odd failure for bob@example.com"),
    }) });
    expect(issues.map((i) => i.kind)).toEqual([
      "proxy", "not_configured", "token_expired", "unauthorized", "no_credentials", "not_installed", "other",
    ]);
    expect(issues.find((i) => i.kind === "no_credentials")!.channels).toEqual(["cursor", "deepseek"]);
    expect(issues.find((i) => i.kind === "token_expired")!.fix).toContain("启动一次 claude");
    expect(issues.find((i) => i.kind === "not_configured")!.fix).toContain("tokenline_base =");
    expect(issues.find((i) => i.kind === "proxy")!.fix).toContain(`${QUOTA_CONFIG} 写一行 proxy =`);
    const other = issues.find((i) => i.kind === "other")!;
    expect(other.problem).toContain("<账号>");
    expect(other.problem).not.toContain("example.com");
  });

  it("covers python and execution failures", () => {
    expect(kinds({ state: "noPython" })).toEqual([["no_python", []]]);
    expect(quotaIssues({ state: "error", message: "额度查询超时" })[0].problem).toContain("额度查询超时");
  });
});

describe("quotaPrompt", () => {
  it("asks for a plain check-and-report when all is well", () => {
    const text = quotaPrompt({ state: "ok", report: report("set", { claude: ok }) });
    expect(text).toContain("检查并汇报");
    expect(text).toContain("主机名 box");
    expect(text).toContain(`curl -fsSL ${QUOTA_SCRIPT_URL}`);
    expect(text).toContain("model-quota.py --json");
    expect(text).not.toContain("问题：");
  });

  it("lists this server's problems with fixes and ends with a self-check", () => {
    const text = quotaPrompt({ state: "ok", report: report("none", {
      claude: fail("network", "unreachable"), "pi-codex": fail("token_expired", "已过期"),
    }) });
    expect(text).toContain("1. 问题：未设代理");
    expect(text).toContain("2. 问题：登录令牌已过期（pi-codex）");
    expect(text).toContain("启动一次 pi");
    expect(text).toMatch(/--json[\s\S]*确认各通道 ok 为 true/);
    expect(text).toContain("不要打印、复制或回显任何令牌");
  });

  it("never carries credentials or accounts from the report", () => {
    const text = quotaPrompt({ state: "ok", report: parseQuotaReport(fixture) });
    expect(text).not.toMatch(/@example\.com|abcdefghijklmnop|alice|sk-/);
    expect(text).toContain("pi-codex");
  });

  it("tells a server without python3 to install it", () => {
    const text = quotaPrompt({ state: "noPython" });
    expect(text).toContain("没有 python3");
    expect(text).toContain("apt install python3");
  });
});
