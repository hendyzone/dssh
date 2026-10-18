/**
 * 「复制提示词」 for the 模型额度 panel: a message for the terminal AI (Claude Code, Codex …) on the
 * server, telling it what is wrong with quota lookup on that machine and how to fix it, then to
 * run the script once and report. Built only from the parsed report: no credentials, no accounts.
 */
import type { QuotaChannel, QuotaReport } from "./quota";

export const QUOTA_SCRIPT_URL =
  "https://raw.githubusercontent.com/hendyzone/dssh/main/tools/model-quota/model-quota.py";
export const QUOTA_CONFIG = "~/.config/model-quota/config";

export type QuotaPromptInput =
  | { state: "ok"; report: QuotaReport }
  | { state: "noPython" }
  | { state: "error"; message: string };

export type IssueKind =
  | "no_python"
  | "proxy"
  | "not_configured"
  | "token_expired"
  | "no_credentials"
  | "not_installed"
  | "unauthorized"
  | "unreachable"
  | "other"
  | "exec";

export interface QuotaIssue {
  kind: IssueKind;
  /** Channels this issue applies to (empty for machine-wide issues). */
  channels: string[];
  /** One line: what is wrong. */
  problem: string;
  /** One line: how to fix it. */
  fix: string;
}

const LOGIN: Record<string, string> = {
  claude: "运行 claude 并按提示登录（/login）",
  codex: "运行 codex login",
  "pi-codex": "在 pi 里 /login 选择 openai-codex",
  cursor: "运行 cursor-agent login",
  agy: "安装并登录 Antigravity CLI（agy）",
  kimi: "在 pi 里配置 kimi-coding 的 API key（写入 ~/.pi/agent/auth.json）",
  deepseek: "在 pi 里配置 deepseek 的 API key（写入 ~/.pi/agent/auth.json）",
  tokenline: "在 pi 里配置 tokenline 的 API key（写入 ~/.pi/agent/auth.json）",
};

const REFRESH: Record<string, string> = {
  claude: "启动一次 claude（交互界面打开后即可退出），它会自己刷新令牌",
  "pi-codex": "启动一次 pi，它会自己刷新 openai-codex 令牌",
  codex: "启动一次 codex，它会自己刷新令牌；仍失败就 codex login 重新登录",
  cursor: "运行 cursor-agent login 重新登录",
};

/** Infer a failure code for output that predates the `code` field. */
export function failureCode(channel: QuotaChannel): string {
  if (channel.code) return channel.code;
  const error = channel.error ?? "";
  if (/本机无凭据|未登录/.test(error)) return "no_credentials";
  if (/缺字段|未配置: /.test(error)) return "missing_field";
  if (/tokenline_base/.test(error)) return "not_configured";
  if (/过期/.test(error)) return "token_expired";
  if (/未装/.test(error)) return "not_installed";
  if (/timed out|超时/.test(error)) return "timeout";
  const http = /HTTP (\d{3})/.exec(error);
  if (http) return `http_${http[1]}`;
  if (/unreachable|urlopen error|Connection/.test(error)) return "network";
  return "error";
}

const NETWORK = new Set(["timeout", "network", "http_403"]);

/** Group the problems of one server into issues, most important first. */
export function quotaIssues(input: QuotaPromptInput): QuotaIssue[] {
  if (input.state === "noPython") {
    return [{
      kind: "no_python",
      channels: [],
      problem: "服务器没有 python3，额度脚本无法运行",
      fix: "用系统包管理器安装 python3（3.8 或更新），例如 apt install python3 / dnf install python3，装好后 command -v python3 能找到",
    }];
  }
  if (input.state === "error") {
    return [{
      kind: "exec",
      channels: [],
      problem: `dssh 在这台机上执行额度脚本失败：${input.message}`,
      fix: "确认 python3 能正常运行（python3 --version，需要 3.8+）、登录 shell 是 bash/zsh 等 POSIX shell，并手动跑一次脚本看报错",
    }];
  }
  const { report } = input;
  const failed = report.channels.filter((c) => !c.ok);
  const by = new Map<IssueKind, string[]>();
  const add = (kind: IssueKind, name: string) => by.set(kind, [...(by.get(kind) ?? []), name]);
  const noProxy = report.proxy === "none";
  for (const channel of failed) {
    const code = failureCode(channel);
    if (NETWORK.has(code)) add(noProxy ? "proxy" : "unreachable", channel.name);
    else if (code === "not_configured") add("not_configured", channel.name);
    else if (code === "token_expired") add("token_expired", channel.name);
    else if (code === "no_credentials" || code === "missing_field") add("no_credentials", channel.name);
    else if (code === "not_installed") add("not_installed", channel.name);
    else if (code === "http_401") add("unauthorized", channel.name);
    else add("other", channel.name);
  }
  const list = (names: string[]) => names.join("、");
  const steps = (names: string[], table: Record<string, string>, fallback: string) =>
    names.map((n) => `${n}：${table[n] ?? fallback}`).join("；");
  const issues: QuotaIssue[] = [];
  const proxy = by.get("proxy");
  if (proxy) issues.push({
    kind: "proxy",
    channels: proxy,
    problem: `未设代理，境外接口连不上（${list(proxy)}）。非交互 SSH 不会加载 shell 配置里的代理`,
    fix: `确认本机代理在运行及其地址（如 http://127.0.0.1:7890，先用 curl -x <代理> -sI https://api.anthropic.com 验证能通），然后在 ${QUOTA_CONFIG} 写一行 proxy = <代理地址>`,
  });
  const unreachable = by.get("unreachable");
  if (unreachable) issues.push({
    kind: "unreachable",
    channels: unreachable,
    problem: `已设代理，但接口仍连不上或超时（${list(unreachable)}）`,
    fix: `检查 ${QUOTA_CONFIG} 或环境变量里的代理是否在运行、能否访问这些接口（curl -x <代理> -sI <接口域名>）；代理换过地址就更新配置`,
  });
  const notConfigured = by.get("not_configured");
  if (notConfigured) issues.push({
    kind: "not_configured",
    channels: notConfigured,
    problem: "tokenline 中转地址未配置，该通道被跳过",
    fix: `如果这台机用 tokenline（new-api 中转），在 ${QUOTA_CONFIG} 写一行 tokenline_base = <中转站地址>（可参考 ~/.pi/agent/models.json 里 tokenline provider 的 baseUrl，去掉末尾 /v1）；不用就忽略`,
  });
  const expired = by.get("token_expired");
  if (expired) issues.push({
    kind: "token_expired",
    channels: expired,
    problem: `登录令牌已过期（${list(expired)}）`,
    fix: `${steps(expired, REFRESH, "启动一次对应工具让它自己刷新令牌")}。不要手工调用刷新接口或改写凭据文件`,
  });
  const unauthorized = by.get("unauthorized");
  if (unauthorized) issues.push({
    kind: "unauthorized",
    channels: unauthorized,
    problem: `接口拒绝了当前凭据（HTTP 401：${list(unauthorized)}）`,
    fix: `${steps(unauthorized, LOGIN, "重新登录对应工具")}，重新登录后再查`,
  });
  const missing = by.get("no_credentials");
  if (missing) issues.push({
    kind: "no_credentials",
    channels: missing,
    problem: `本机没有这些工具的登录凭据（${list(missing)}）`,
    fix: `这台机要用哪个就登录哪个——${steps(missing, LOGIN, "登录对应工具")}；不在这台机用的通道无需处理`,
  });
  const notInstalled = by.get("not_installed");
  if (notInstalled) issues.push({
    kind: "not_installed",
    channels: notInstalled,
    problem: `未安装（${list(notInstalled)}）`,
    fix: "这台机需要时再安装，否则忽略",
  });
  const other = by.get("other");
  if (other) issues.push({
    kind: "other",
    channels: other,
    problem: `其他错误（${other.map((n) => {
      const channel = failed.find((c) => c.name === n);
      return `${n}：${redact(channel?.error ?? "")}`;
    }).join("；")}）`,
    fix: "按错误信息排查；非官方接口可能已改版，先确认对应工具本身能正常使用",
  });
  return issues;
}

/** Errors are already scrubbed; additionally drop anything that still looks like an account. */
function redact(text: string): string {
  return text.replace(/[\w.+-]*…?@[\w-]+(?:\.[\w-]+)+/g, "<账号>").slice(0, 160);
}

/** The text copied to the clipboard. */
export function quotaPrompt(input: QuotaPromptInput): string {
  const issues = quotaIssues(input);
  const host = input.state === "ok" && input.report.host ? `（主机名 ${input.report.host}）` : "";
  const run = [
    "```bash",
    "mkdir -p ~/.local/share/model-quota",
    `curl -fsSL ${QUOTA_SCRIPT_URL} -o ~/.local/share/model-quota/model-quota.py`,
    "python3 ~/.local/share/model-quota/model-quota.py --json",
    "```",
  ];
  const rules = [
    "注意：",
    "- 只读排查，不要打印、复制或回显任何令牌、密钥和凭据文件内容；配置文件里只放代理地址和中转站地址，不放密钥。",
    `- ${QUOTA_CONFIG} 每行一个 key = value（可用键：proxy、tokenline_base、timeout），建议 chmod 600。`,
    "- 不要为了查额度去手动刷新 OAuth 令牌（会把正在用它的工具顶掉），让对应工具自己启动时刷新。",
    "- 下载脚本需要能访问 GitHub；连不上时先按上面配好代理（curl -x <代理>），或告诉我，我在 dssh 面板点刷新复查。",
  ];
  if (!issues.length) {
    return [
      `请在这台服务器${host}上检查并汇报 AI 编码工具的剩余额度（dssh 额度面板当前显示各通道正常）。`,
      "",
      "运行额度脚本（单文件、只用 Python 标准库、只读）：",
      ...run,
      "",
      "然后用一张表汇报：通道、状态、主要窗口剩余百分比（agy 的 left_pct 本身就是剩余，其余 *_pct 是已用，换算成剩余）、重置时间；剩余 ≤25% 的单独指出。不要写出账号。",
      "",
      ...rules,
    ].join("\n");
  }
  return [
    `请在这台服务器${host}上把模型额度查询配好并自检。dssh 额度面板在这台机上发现以下问题：`,
    "",
    ...issues.map((issue, i) => `${i + 1}. 问题：${issue.problem}\n   修法：${issue.fix}`),
    "",
    "逐条处理（不在这台机用的工具可以跳过，回报时说明），然后运行额度脚本自检（单文件、只用 Python 标准库、只读）：",
    ...run,
    "",
    "确认各通道 ok 为 true（或说明为什么某通道在这台机上不需要），再用一张表回报：通道、状态、剩余百分比、重置时间，以及你改了哪些配置。不要写出账号。",
    "",
    ...rules,
  ].join("\n");
}
