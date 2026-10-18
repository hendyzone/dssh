import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { Button } from "./ui/button";
import { IconClose } from "./Icons";
import {
  maskAccount,
  parseQuotaReport,
  quotaLevel,
  quotaStale,
  sharedAccounts,
  type QuotaChannel,
  type QuotaReport,
} from "../lib/quota";
import "./QuotaPanel.css";

export interface QuotaServer {
  id: string;
  name: string;
  sessionId: string;
}

type Entry =
  | { state: "ok"; report: QuotaReport; fetchedAt: number }
  | { state: "missing"; fetchedAt: number }
  | { state: "error"; message: string; fetchedAt: number };

type RemoteResult =
  | { kind: "ok"; body: string }
  | { kind: "missing" }
  | { kind: "failed"; message: string };

/** Results survive closing the panel so reopening within 5 minutes does not re-query. */
const cache = new Map<string, Entry>();
export const resetQuotaCache = () => cache.clear();

async function fetchQuota(sessionId: string): Promise<Entry> {
  const fetchedAt = Date.now();
  try {
    const result = await invoke<RemoteResult>("quota_fetch", { sessionId });
    if (result.kind === "missing") return { state: "missing", fetchedAt };
    if (result.kind === "failed") return { state: "error", message: result.message, fetchedAt };
    return { state: "ok", report: parseQuotaReport(result.body), fetchedAt };
  } catch (reason) {
    return {
      state: "error",
      message: reason instanceof Error ? reason.message : String(reason),
      fetchedAt,
    };
  }
}

const ALL = "__all__";
const QUOTA_CHECK_MS = 30_000;
const clock = (time: number) =>
  new Date(time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

function ChannelRow({ channel, shared }: { channel: QuotaChannel; shared?: string[] }) {
  const primary = channel.windows.filter((w) => w.primary);
  const secondary = channel.windows.filter((w) => !w.primary && w.leftPct !== null);
  return (
    <li className={`quota-channel quota-${channel.level}`} data-channel={channel.name}>
      <div className="quota-channel-head">
        <strong>{channel.name}</strong>
        {channel.plan && <small>{channel.plan}</small>}
        <span className="quota-status">
          {!channel.ok ? "FAIL" : channel.leftPct === null ? "OK" : `剩 ${channel.leftPct}%`}
        </span>
      </div>
      {channel.error && <p className="quota-error">{channel.error}</p>}
      {primary.map((w) => (
        <div key={w.id} className="quota-window">
          <span className="quota-window-label" title={w.label}>{w.label}</span>
          <span
            className="quota-bar"
            role="meter"
            aria-label={`${channel.name} ${w.label} 剩余`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={w.leftPct ?? undefined}
          >
            <span
              className={`quota-fill quota-fill-${quotaLevel(w.leftPct)}`}
              style={{ width: `${w.leftPct ?? 0}%` }}
            />
          </span>
          <span className="quota-window-value">{w.leftPct === null ? "未知" : `${w.leftPct}%`}</span>
          {w.reset && <small className="quota-reset">{w.reset} 重置</small>}
        </div>
      ))}
      {secondary.length > 0 && (
        <small className="quota-secondary">
          {secondary.map((w) => `${w.label} 剩 ${w.leftPct}%`).join(" · ")}
        </small>
      )}
      {channel.summary.length > 0 && <small className="quota-summary">{channel.summary.join(" · ")}</small>}
      {(channel.account || channel.notes.length > 0 || shared) && (
        <small className="quota-notes">
          {[
            channel.account ? `账号 ${maskAccount(channel.account)}` : "",
            ...channel.notes,
            shared ? `与 ${shared.join("、")} 共用` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      )}
    </li>
  );
}

export default function QuotaPanel({
  servers,
  currentId,
  visible,
  onClose,
}: {
  servers: QuotaServer[];
  currentId?: string;
  visible: boolean;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<string>(currentId ?? servers[0]?.id ?? "");
  const [, setRevision] = useState(0);
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const inflight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const selected = selection === ALL ? null : servers.find((s) => s.id === selection);
  const targets = selection === ALL ? servers : selected ? [selected] : servers.filter((s) => s.id === currentId);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const targetsKey = targets.map((s) => `${s.id}:${s.sessionId}`).join("|");

  const refresh = useCallback(async (force: boolean) => {
    const now = Date.now();
    const due = targetsRef.current.filter(
      (s) => s.sessionId && !inflight.current.has(s.id) && (force || quotaStale(cache.get(s.id)?.fetchedAt, now)),
    );
    if (!due.length) return;
    due.forEach((s) => inflight.current.add(s.id));
    setLoading(new Set(inflight.current));
    await Promise.all(
      due.map(async (s) => {
        const entry = await fetchQuota(s.sessionId);
        cache.set(s.id, entry);
        inflight.current.delete(s.id);
        if (mounted.current) {
          setLoading(new Set(inflight.current));
          setRevision((v) => v + 1);
        }
      }),
    );
  }, []);

  // Poll only while the panel is shown and the window is visible.
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState === "hidden") return;
      void refresh(false);
      // Cheap local check; a server is only queried once its result is 5 minutes old.
      timer = setInterval(() => void refresh(false), QUOTA_CHECK_MS);
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? stop() : start());
    start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [visible, targetsKey, refresh]);

  const loaded = servers.flatMap((s) => {
    const entry = cache.get(s.id);
    return entry?.state === "ok" ? [{ server: s.id, name: s.name, report: entry.report }] : [];
  });
  const shared = sharedAccounts(loaded);

  return (
    <aside className="workspace-panel quota-panel">
      <header data-panel-drag-handle tabIndex={0}>
        <strong>模型额度</strong>
        <span className="quota-header-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新"
            aria-label="刷新额度"
            disabled={loading.size > 0 || targets.length === 0}
            onClick={() => void refresh(true)}
          >
            <RefreshCw size={14} className={loading.size ? "quota-spin" : ""} />
          </Button>
          <Button variant="ghost" size="icon-sm" title="关闭" onClick={onClose}>
            <IconClose />
          </Button>
        </span>
      </header>
      {servers.length > 1 && (
        <div className="workspace-actions">
          <select aria-label="服务器" value={selection} onChange={(event) => setSelection(event.target.value)}>
            {servers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value={ALL}>全部服务器（并列）</option>
          </select>
        </div>
      )}
      <p className="workspace-hint">
        在服务器上运行 ~/.amail/client/scripts/quota.sh；额度跟账号凭据走，每台机各查各的。面板打开时每 5 分钟刷新。
      </p>
      <div className="workspace-scroll">
        {targets.length === 0 && <p>连接服务器后查看额度。</p>}
        {targets.map((server) => {
          const entry = cache.get(server.id);
          const busy = loading.has(server.id);
          return (
            <section key={server.id} className="quota-server" aria-label={`${server.name} 额度`}>
              <h4>
                <span>{server.name}</span>
                <small>
                  {busy ? "查询中…" : entry ? `更新于 ${clock(entry.fetchedAt)}` : ""}
                </small>
              </h4>
              {!entry && (busy ? <p className="workspace-hint">正在查询各家接口，约需十几秒…</p> : !server.sessionId && <p>未连接。</p>)}
              {entry?.state === "missing" && (
                <p className="quota-missing" role="status">
                  这台服务器没有 ~/.amail/client/scripts/quota.sh，未安装 amail 客户端。装好 amail 客户端后点刷新。
                </p>
              )}
              {entry?.state === "error" && (
                <p className="workspace-error" role="alert">
                  {entry.message}
                </p>
              )}
              {entry?.state === "ok" && (
                <>
                  {entry.report.proxy === "none" && (
                    <p className="workspace-hint">服务器未设代理：境外接口（claude、codex 等）可能 FAIL。</p>
                  )}
                  <ul className="quota-list">
                    {entry.report.channels.map((channel) => (
                      <ChannelRow
                        key={channel.name}
                        channel={channel}
                        shared={shared.get(`${server.id}/${channel.name}`)}
                      />
                    ))}
                  </ul>
                </>
              )}
            </section>
          );
        })}
      </div>
    </aside>
  );
}
