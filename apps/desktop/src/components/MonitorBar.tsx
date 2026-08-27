import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Stats {
  cpuPct: number | null;
  memPct: number;
  diskPct: number;
  load1: number;
  load5: number;
  load15: number;
}

/** 会话底部监控条：CPU / 内存 / 磁盘 / 负载 */
export default function MonitorBar({
  backendId,
}: {
  backendId: string | null;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!enabled || !backendId) return;
    let unlisten: (() => void) | null = null;
    invoke("monitor_start", { sessionId: backendId }).catch(() =>
      setEnabled(false),
    );
    listen<Stats>(`monitor://${backendId}/stats`, (e) =>
      setStats(e.payload),
    ).then((u) => (unlisten = u));
    return () => {
      unlisten?.();
      invoke("monitor_stop", { sessionId: backendId }).catch(() => {});
    };
  }, [enabled, backendId]);

  if (!enabled) {
    return (
      <div className="monitor-bar">
        <button className="monitor-toggle" onClick={() => setEnabled(true)}>
          📊 开启监控
        </button>
      </div>
    );
  }

  return (
    <div className="monitor-bar">
      <button className="monitor-toggle on" onClick={() => setEnabled(false)}>
        📊
      </button>
      {stats ? (
        <>
          <Meter label="CPU" pct={stats.cpuPct} />
          <Meter label="内存" pct={stats.memPct} />
          <Meter label="磁盘" pct={stats.diskPct} />
          <span className="monitor-load">
            负载 {stats.load1.toFixed(2)} / {stats.load5.toFixed(2)} /{" "}
            {stats.load15.toFixed(2)}
          </span>
        </>
      ) : (
        <span className="monitor-load">采集中…</span>
      )}
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number | null }) {
  const v = pct ?? 0;
  const color =
    v > 85 ? "var(--ui-danger)" : v > 60 ? "#e0af68" : "var(--ui-accent)";
  return (
    <span className="monitor-meter">
      <span className="monitor-label">{label}</span>
      <span className="monitor-track">
        <span
          className="monitor-fill"
          style={{ width: `${v.toFixed(0)}%`, background: color }}
        />
      </span>
      <span className="monitor-value">
        {pct === null ? "–" : `${v.toFixed(0)}%`}
      </span>
    </span>
  );
}
