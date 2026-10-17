import { NO_SOURCE, formatAge, type BoardSource } from "../lib/taskLookup";
import type { LiveSessions, TeamSummary } from "../lib/agentSessions";

/** Board state and the top-of-panel counts; rendered by both team pages so they read the same. */
export default function TeamLiveSummary({ board, live, summary }: { board?: BoardSource; live: LiveSessions; summary: TeamSummary }) {
  if (!board) return <p className="team-live-note">未配置看板，无法显示实时状态：{NO_SOURCE}。下面按 Lead 手写状态显示。</p>;
  if (live.offline) return <p role="status" className="team-live-offline" title={live.error}>
    看板离线{live.fetchedAt ? `（上次成功 ${formatAge(new Date(live.fetchedAt).toISOString())}前）` : ""} · 下面按 Lead 手写状态显示，可能过期；每分钟自动重试
  </p>;
  if (!summary.live) return <p role="status" className="team-live-note">正在读取看板会话…</p>;
  return <p className="team-live-summary" aria-label="团队汇总">
    <span className={summary.attention ? "is-bad" : ""}>需要处理 <b>{summary.attention}</b></span>
    <span className={summary.waitLead ? "is-lead" : ""}>等 Lead <b>{summary.waitLead}</b>{summary.longestWaitLead && <small>（最长 {summary.longestWaitLead}）</small>}</span>
    {summary.review > 0 && <span>待验收 <b>{summary.review}</b></span>}
    <span>可派活 <b>{summary.available}</b></span>
  </p>;
}
