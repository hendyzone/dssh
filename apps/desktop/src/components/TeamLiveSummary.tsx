import { NO_SOURCE, formatAge, type BoardSource } from "../lib/taskLookup";
import type { LiveSessions, StatusGroup, TeamSummary } from "../lib/agentSessions";

/**
 * Top-of-panel counts as clickable blocks. Clicking one filters the list below to that group;
 * clicking it again clears the filter. The board state notes (not configured / offline / loading)
 * take the same slot so the panel always says why live counts are missing.
 */
export default function TeamLiveSummary({ board, live, summary, filter, onFilter }: {
  board?: BoardSource; live: LiveSessions; summary: TeamSummary;
  filter?: StatusGroup;
  onFilter?: (group: StatusGroup) => void;
}) {
  if (!board) return <p className="team-live-note">未配置看板，无法显示实时状态：{NO_SOURCE}。下面按 Lead 手写状态显示。</p>;
  if (live.offline) return <p role="status" className="team-live-offline" title={live.error}>
    看板离线{live.fetchedAt ? `（上次成功 ${formatAge(new Date(live.fetchedAt).toISOString())}前）` : ""} · 下面按 Lead 手写状态显示，可能过期；每分钟自动重试
  </p>;
  if (!summary.live) return <p role="status" className="team-live-note">正在读取看板会话…</p>;
  const chips = [
    { key: "attention" as const, label: "需要处理", count: summary.attention, tone: "bad",
      title: "卡住、确认框、输入框残留、会话已离开但卡仍在进行中" },
    { key: "waitLead" as const, label: "等 Lead", count: summary.waitLead, tone: "wait",
      title: "worker 已空闲，卡仍在进行中 / 阻塞：活干完了在等 Lead 处理" },
    { key: "available" as const, label: "可派活", count: summary.available, tone: "idle",
      title: "worker 空闲，名下没有进行中 / 阻塞 / 待验收的卡" },
  ];
  return <div className="team-live-counts" role="group" aria-label="团队汇总">
    {chips.map(chip => <button type="button" key={chip.key}
      className={`team-count is-${chip.tone}${chip.count ? "" : " is-zero"}${filter === chip.key ? " is-on" : ""}`}
      aria-pressed={filter === chip.key}
      title={`${chip.title}（点击筛选，再点取消）`}
      onClick={() => onFilter?.(chip.key)}>
      <b>{chip.count}</b><span>{chip.label}</span>
    </button>)}
  </div>;
}
