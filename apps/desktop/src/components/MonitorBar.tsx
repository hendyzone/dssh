import { NativeSelect } from "./ui/native-select";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import { IconClose } from "./Icons";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { listen } from "../platform/event";
import { IconMonitor } from "./Icons";
import {
  bytes,
  speed,
  uptime,
  networkRate,
  type MonitorStats,
} from "../lib/monitor";
import "./MonitorBar.css";

let control: Promise<unknown> = Promise.resolve();
function command(name: string, args: { sessionId: string; ownerId: string }) {
  control = control.catch(() => {}).then(() => invoke(name, args));
  return control;
}
export default function MonitorBar({
  backendId,
  detailsOpen,
  onDetailsToggle,
  targetId,
}: {
  backendId: string | null;
  detailsOpen?: boolean;
  onDetailsToggle?: () => void;
  targetId?: string;
}) {
  const [enabled, setEnabled] = useState(false);
  const [localExpanded, setExpanded] = useState(false);
  const expanded = detailsOpen ?? localExpanded;
  useEffect(() => {
    if (detailsOpen) setEnabled(true);
  }, [detailsOpen]);
  const toggle = () =>
    onDetailsToggle ? onDetailsToggle() : setExpanded((v) => !v);
  const close = () => {
    if (detailsOpen) onDetailsToggle?.();
    setExpanded(false);
  };
  return (
    <div className="monitor-shell">
      {enabled && backendId ? (
        <MonitorSession
          key={backendId}
          backendId={backendId}
          targetId={targetId}
          expanded={expanded}
          onExpand={toggle}
          onClose={close}
          onStop={() => {
            setEnabled(false);
            close();
          }}
        />
      ) : (
        <div className="monitor-bar">
          <Button
            variant="outline"
            size="sm"
            className="monitor-toggle"
            disabled={!backendId}
            onClick={() => {
              setEnabled(true);
              toggle();
            }}
          >
            <IconMonitor size={13} />
            {backendId ? "开启监控" : "连接后可开启监控"}
          </Button>
        </div>
      )}
    </div>
  );
}
function MonitorSession({
  backendId,
  targetId,
  expanded,
  onExpand,
  onClose,
  onStop,
}: {
  backendId: string;
  targetId?: string;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
  onStop: () => void;
}) {
  const [stats, setStats] = useState<MonitorStats | null>(null);
  const [history, setHistory] = useState<MonitorStats[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let disposed = false;
    let started = false;
    const cleanups: (() => void)[] = [];
    const args = { sessionId: backendId, ownerId: crypto.randomUUID() };
    const event = `monitor://${backendId}/${args.ownerId}`;
    setStats(null);
    setHistory([]);
    setError(null);
    setUpdated(null);
    const register = async <T,>(
      name: string,
      handler: (payload: T) => void,
    ) => {
      const off = await listen<T>(name, (e) => {
        if (!disposed) handler(e.payload);
      });
      if (disposed) off();
      else cleanups.push(off);
    };
    void (async () => {
      try {
        await register<MonitorStats>(`${event}/stats`, (payload) => {
          setStats(payload);
          setHistory((h) => [...h.slice(-59), payload]);
          setUpdated(new Date());
          setError(null);
        });
        if (disposed) return;
        await register<string>(`${event}/error`, setError);
        if (disposed) return;
        started = true;
        await command("monitor_start", args);
      } catch (e) {
        if (!disposed)
          setError(
            typeof e === "string" ? e : JSON.stringify(e) || "无法开启监控",
          );
      }
    })();
    return () => {
      disposed = true;
      cleanups.forEach((off) => off());
      if (started) void command("monitor_stop", args).catch(() => {});
    };
  }, [backendId, attempt]);
  const close = () => {
    onClose();
    expandButton.current?.focus();
  };
  const root = stats?.disks.find((d) => d.mount === "/");
  const memory = stats?.memory;
  const processes = (stats?.processes ?? [])
    .filter((p) =>
      `${p.pid} ${p.command}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => b[sort] - a[sort] || a.pid - b.pid);
  return (
    <>
      <div className="monitor-bar">
        <Button
          variant="ghost"
          size="icon-sm"
          className="monitor-toggle on"
          onClick={onStop}
          title="停止监控"
          aria-label="停止监控"
        >
          <IconMonitor size={13} />
        </Button>
        {error ? (
          <span className="monitor-error" role="alert">
            {error}{" "}
            <Button
              variant="outline"
              size="sm"
              className="monitor-toggle"
              onClick={() => setAttempt((v) => v + 1)}
            >
              重试
            </Button>
          </span>
        ) : stats ? (
          <>
            <Meter label="CPU" pct={stats.cpuPct} />
            <Meter
              label="内存"
              pct={memory ? (memory.used / memory.total) * 100 : null}
            />
            <Meter label="磁盘" pct={root?.pct ?? null} />
            <span className="monitor-summary-net">
              ↑ {speed(networkRate(stats, "sendRate"))}　↓{" "}
              {speed(networkRate(stats, "receiveRate"))}
            </span>
          </>
        ) : (
          <span role="status">正在采集 Linux 系统指标…</span>
        )}
        <Button
          variant="outline"
          size="sm"
          ref={expandButton}
          className="monitor-toggle monitor-expand"
          onClick={onExpand}
          aria-expanded={expanded}
        >
          监控详情 {expanded ? "⌄" : "⌃"}
        </Button>
      </div>
      {expanded && (
        <MonitorPortal targetId={targetId}>
          <section
            className="monitor-details"
            aria-label="服务器监控详情"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                close();
              }
            }}
          >
            <header
              className="monitor-heading"
              data-panel-drag-handle
              tabIndex={0}
            >
              <div>
                <strong>服务器监控</strong>
                <span>
                  {stats?.hostname ?? "Linux"} ·{" "}
                  {error
                    ? "采集已停止 · 数据已过期"
                    : updated
                      ? `更新于 ${updated.toLocaleTimeString()} · 每 3 秒采样`
                      : "等待首次采样"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                className="close-icon-btn"
                onClick={close}
                aria-label="收起监控详情"
              >
                <IconClose size={14} />
              </Button>
            </header>
            {!stats ? (
              <div className="monitor-empty">
                {error ?? "正在获取服务器信息，速率指标需要两次采样。"}
              </div>
            ) : (
              <div className={`monitor-grid ${error ? "monitor-stale" : ""}`}>
                <section className="monitor-card monitor-wide monitor-system">
                  <div>
                    <span>操作系统</span>
                    <strong>{stats.os ?? "不可用"}</strong>
                  </div>
                  <div>
                    <span>内核</span>
                    <strong>{stats.kernel ?? "—"}</strong>
                  </div>
                  <div>
                    <span>运行时间</span>
                    <strong>{uptime(stats.uptime)}</strong>
                  </div>
                </section>
                <section className="monitor-card">
                  <h3>
                    CPU{" "}
                    <b>
                      {stats.cpuPct == null
                        ? "等待采样"
                        : `${stats.cpuPct.toFixed(1)}%`}
                    </b>
                  </h3>
                  <Sparkline
                    values={history.map((s) => s.cpuPct)}
                    label="CPU 使用率趋势"
                    max={100}
                  />
                  <div className="monitor-cores">
                    {stats.cpus.map((c) => (
                      <Meter
                        key={c.name}
                        label={c.name.replace("cpu", "核心 ")}
                        pct={c.pct}
                      />
                    ))}
                  </div>
                  <p className="monitor-note">
                    负载 1 / 5 / 15 分钟：
                    {stats.loads?.map((n) => n.toFixed(2)).join(" / ") ??
                      "不可用"}
                  </p>
                </section>
                <section className="monitor-card">
                  <h3>
                    内存 <b>{bytes(memory?.total)}</b>
                  </h3>
                  {memory ? (
                    <>
                      <Meter
                        label="使用率"
                        pct={(memory.used / memory.total) * 100}
                      />
                      <dl className="monitor-metrics">
                        <div>
                          <dt>已用</dt>
                          <dd>{bytes(memory.used)}</dd>
                        </div>
                        <div>
                          <dt>可用</dt>
                          <dd>{bytes(memory.available)}</dd>
                        </div>
                        <div>
                          <dt>缓存</dt>
                          <dd>{bytes(memory.cached)}</dd>
                        </div>
                        <div>
                          <dt>Swap 已用 / 总量</dt>
                          <dd>
                            {bytes(memory.swapUsed)} / {bytes(memory.swapTotal)}
                          </dd>
                        </div>
                      </dl>
                      <p className="monitor-note">
                        已用 = 总量 − 可用；缓存与可用内存存在重叠。
                      </p>
                    </>
                  ) : (
                    <Empty />
                  )}
                </section>
                <section className="monitor-card monitor-wide">
                  <h3>
                    网络{" "}
                    <b>
                      ↑ 上传　<span className="monitor-blue">↓ 下载</span>
                    </b>
                  </h3>
                  <Sparkline
                    values={history.map((s) => networkRate(s, "sendRate"))}
                    secondary={history.map((s) =>
                      networkRate(s, "receiveRate"),
                    )}
                    label="网络上传下载速率趋势"
                  />
                  {stats.networks.length ? (
                    <div className="monitor-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>网卡</th>
                            <th>上传 / 秒</th>
                            <th>下载 / 秒</th>
                            <th>累计上传</th>
                            <th>累计下载</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.networks.map((n) => (
                            <tr key={n.name}>
                              <td>{n.name}</td>
                              <td>{speed(n.sendRate)}</td>
                              <td>{speed(n.receiveRate)}</td>
                              <td>{bytes(n.sent)}</td>
                              <td>{bytes(n.received)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty />
                  )}
                  <p className="monitor-note">
                    趋势为非回环网卡速率之和；虚拟网卡可能重复计数。累计流量来自网卡计数器。
                  </p>
                </section>
                <section className="monitor-card monitor-wide">
                  <h3>磁盘与读写</h3>
                  {stats.disks.length ? (
                    <div className="monitor-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>挂载点 / 设备</th>
                            <th>类型</th>
                            <th>已用 / 总量</th>
                            <th>可用</th>
                            <th>使用率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.disks.map((d) => (
                            <tr key={`${d.device}:${d.mount}`}>
                              <td title={d.device}>
                                {d.mount}
                                <small>{d.device}</small>
                              </td>
                              <td>{d.fsType}</td>
                              <td>
                                {bytes(d.used)} / {bytes(d.total)}
                              </td>
                              <td>{bytes(d.available)}</td>
                              <td>
                                <Meter label="" pct={d.pct} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <Empty />
                  )}
                  <details className="monitor-io">
                    <summary>设备读写速度（{stats.diskIo.length}）</summary>
                    {stats.diskIo.length ? (
                      <div className="monitor-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>设备</th>
                              <th>读取 / 秒</th>
                              <th>写入 / 秒</th>
                            </tr>
                          </thead>
                          <tbody>
                            {stats.diskIo.map((d) => (
                              <tr key={d.name}>
                                <td>{d.name}</td>
                                <td>{speed(d.readRate)}</td>
                                <td>{speed(d.writeRate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <Empty />
                    )}
                  </details>
                </section>
                <section className="monitor-card monitor-wide">
                  <h3>
                    进程 <b>{stats.processes.length} 个候选进程</b>
                  </h3>
                  <div className="monitor-process-tools">
                    <Input
                      aria-label="搜索进程"
                      placeholder="搜索 PID 或命令"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <NativeSelect
                      aria-label="进程排序"
                      value={sort}
                      onChange={(e) => setSort(e.target.value as "cpu" | "mem")}
                    >
                      <option value="cpu">按 CPU 排序</option>
                      <option value="mem">按内存排序</option>
                    </NativeSelect>
                  </div>
                  {stats.processesAvailable ? (
                    <>
                      <div className="monitor-table-wrap">
                        <table className="monitor-processes">
                          <thead>
                            <tr>
                              <th>PID</th>
                              <th>CPU</th>
                              <th>内存</th>
                              <th>命令</th>
                            </tr>
                          </thead>
                          <tbody>
                            {processes
                              .slice(0, showAll ? processes.length : 8)
                              .map((p) => (
                                <tr key={p.pid}>
                                  <td>{p.pid}</td>
                                  <td>{p.cpu.toFixed(1)}%</td>
                                  <td>{p.mem.toFixed(1)}%</td>
                                  <td title={p.command}>{p.command}</td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      {!processes.length && (
                        <p className="monitor-note">没有匹配的进程</p>
                      )}
                      {processes.length > 8 && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="monitor-toggle"
                          onClick={() => setShowAll((v) => !v)}
                        >
                          {showAll
                            ? "收起列表"
                            : `查看全部 ${processes.length} 个候选进程`}
                        </Button>
                      )}
                    </>
                  ) : (
                    <Empty />
                  )}
                  <p className="monitor-note">
                    候选集取 CPU、内存前 100 名的并集。CPU 为 ps
                    报告的进程生命周期平均值，可超过 100%。
                  </p>
                </section>
              </div>
            )}
          </section>
        </MonitorPortal>
      )}
    </>
  );
}
function Empty() {
  return <p className="monitor-note">此主机未提供该指标</p>;
}
function Meter({ label, pct }: { label: string; pct: number | null }) {
  const v = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <span className="monitor-meter">
      <span className="monitor-label">{label}</span>
      <span className="monitor-track">
        <span
          className="monitor-fill"
          style={{
            width: `${v}%`,
            background:
              v > 85
                ? "var(--ui-danger)"
                : v > 60
                  ? "#e0af68"
                  : "var(--ui-accent)",
          }}
        />
      </span>
      <span className="monitor-value">
        {pct == null ? "—" : `${v.toFixed(1)}%`}
      </span>
    </span>
  );
}
function Sparkline({
  values,
  secondary,
  label,
  max,
}: {
  values: (number | null)[];
  secondary?: (number | null)[];
  label: string;
  max?: number;
}) {
  const ceiling =
    max ??
    Math.max(
      1,
      ...values.map((v) => v ?? 0),
      ...(secondary ?? []).map((v) => v ?? 0),
    );
  const path = (items: (number | null)[]) =>
    items
      .map((v, i) =>
        v == null
          ? ""
          : `${i === 0 || items[i - 1] == null ? "M" : "L"}${(i / 59) * 600},${54 - (Math.min(ceiling, Math.max(0, v)) / ceiling) * 48}`,
      )
      .join(" ");
  return (
    <div className="monitor-chart">
      <svg
        viewBox="0 0 600 60"
        role="img"
        aria-label={label}
        preserveAspectRatio="none"
      >
        <path d="M0 6H600 M0 30H600 M0 54H600" className="monitor-gridlines" />
        <path d={path(values)} className="monitor-line" />
        {secondary && (
          <path
            d={path(secondary)}
            className="monitor-line monitor-line-blue"
          />
        )}
      </svg>
      <span>
        {max ? "0–100%" : `峰值 ${speed(ceiling)}`} · 最近 {values.length} / 60
        次采样
      </span>
    </div>
  );
}

function MonitorPortal({
  targetId,
  children,
}: {
  targetId?: string;
  children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setTarget(targetId ? document.getElementById(targetId) : null);
  }, [targetId]);
  return targetId ? (target ? createPortal(children, target) : null) : children;
}
