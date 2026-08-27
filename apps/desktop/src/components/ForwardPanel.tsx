import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ForwardType = "local" | "remote" | "dynamic";

type ForwardRule = {
  ruleType: ForwardType;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
};

type ForwardStatus = {
  ruleId: string;
  sessionId: string;
  rule: ForwardRule;
  running: boolean;
};

type Props = { sessionId: string; onClose: () => void };

const colors = {
  panel: "var(--ui-panelAlt)",
  text: "var(--ui-fg)",
  accent: "var(--ui-accent)",
  muted: "var(--ui-muted)",
  border: "var(--ui-border)",
  input: "var(--ui-panel)",
};

const typeInfo: Record<
  ForwardType,
  { label: string; short: string; color: string }
> = {
  local: { label: "本地转发", short: "L", color: "#9ece6a" },
  remote: { label: "远程转发", short: "R", color: "#bb9af7" },
  dynamic: { label: "动态 SOCKS5", short: "D", color: "#e0af68" },
};

function endpoint(host: string, port: number): string {
  return `${host}:${port}`;
}

export default function ForwardPanel({ sessionId, onClose }: Props) {
  const [forwards, setForwards] = useState<ForwardStatus[]>([]);
  const [ruleType, setRuleType] = useState<ForwardType>("local");
  const [localHost, setLocalHost] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState("8080");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("3306");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return; // 会话尚未建立
    try {
      setForwards(await invoke<ForwardStatus[]>("forward_list", { sessionId }));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const stop = async (ruleId: string) => {
    try {
      await invoke("forward_stop", { ruleId });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsedLocalPort = Number(localPort);
    const parsedRemotePort = Number(remotePort);
    if (
      !localHost.trim() ||
      !Number.isInteger(parsedLocalPort) ||
      parsedLocalPort < 1 ||
      parsedLocalPort > 65535
    ) {
      setError("请输入有效的本地地址和端口");
      return;
    }
    if (
      ruleType !== "dynamic" &&
      (!remoteHost.trim() ||
        !Number.isInteger(parsedRemotePort) ||
        parsedRemotePort < 1 ||
        parsedRemotePort > 65535)
    ) {
      setError("请输入有效的远程地址和端口");
      return;
    }
    setBusy(true);
    if (!sessionId) {
      setBusy(false);
      setError("会话尚未建立，稍候再试");
      return;
    }
    try {
      await invoke("forward_start", {
        sessionId,
        rule: {
          ruleType,
          localHost: localHost.trim(),
          localPort: parsedLocalPort,
          remoteHost: remoteHost.trim(),
          remotePort: parsedRemotePort,
        },
      });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ruleId: string) => {
    // stop is also the backend's delete operation; a stopped rule disappears
    // from forward_list and is therefore removed from the panel.
    await stop(ruleId);
  };

  return (
    <aside className="forward-panel" style={styles.panel}>
      <header style={styles.header}>
        <strong>端口转发</strong>
        <button
          type="button"
          onClick={onClose}
          style={styles.close}
          aria-label="关闭"
        >
          ×
        </button>
      </header>

      <div style={styles.list}>
        {forwards.length === 0 ? (
          <div style={styles.empty}>暂无转发规则</div>
        ) : (
          forwards.map((item) => {
            const info = typeInfo[item.rule.ruleType];
            const description =
              item.rule.ruleType === "remote"
                ? `${endpoint(item.rule.remoteHost, item.rule.remotePort)} → ${endpoint(item.rule.localHost, item.rule.localPort)}`
                : item.rule.ruleType === "dynamic"
                  ? `${endpoint(item.rule.localHost, item.rule.localPort)} → SOCKS5`
                  : `${endpoint(item.rule.localHost, item.rule.localPort)} → ${endpoint(item.rule.remoteHost, item.rule.remotePort)}`;
            return (
              <div key={item.ruleId} style={styles.row}>
                <span style={{ ...styles.badge, background: info.color }}>
                  {info.short}
                </span>
                <div style={styles.details}>
                  <div style={styles.description} title={info.label}>
                    {description}
                  </div>
                  <div style={styles.state}>
                    <span
                      style={{
                        ...styles.dot,
                        background: item.running ? "#9ece6a" : "var(--ui-danger)",
                      }}
                    />
                    {item.running ? "运行中" : "已停止"}
                  </div>
                </div>
                <button
                  type="button"
                  style={styles.smallButton}
                  onClick={() => void stop(item.ruleId)}
                >
                  {item.running ? "停止" : "启动"}
                </button>
                <button
                  type="button"
                  style={styles.delete}
                  onClick={() => void remove(item.ruleId)}
                  aria-label="删除"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={add} style={styles.form}>
        <div style={styles.formTitle}>添加并启动</div>
        <select
          value={ruleType}
          onChange={(event) => setRuleType(event.target.value as ForwardType)}
          style={styles.field}
        >
          <option value="local">本地转发</option>
          <option value="remote">远程转发</option>
          <option value="dynamic">动态 SOCKS5</option>
        </select>
        <label style={styles.label}>本地地址:端口</label>
        <div style={styles.inline}>
          <input
            value={localHost}
            onChange={(event) => setLocalHost(event.target.value)}
            style={{ ...styles.field, flex: 1 }}
            placeholder="127.0.0.1"
          />
          <input
            value={localPort}
            onChange={(event) => setLocalPort(event.target.value)}
            style={{ ...styles.port, width: 72 }}
            inputMode="numeric"
            placeholder="8080"
          />
        </div>
        {ruleType !== "dynamic" && (
          <>
            <label style={styles.label}>远程地址:端口</label>
            <div style={styles.inline}>
              <input
                value={remoteHost}
                onChange={(event) => setRemoteHost(event.target.value)}
                style={{ ...styles.field, flex: 1 }}
                placeholder="远程主机"
              />
              <input
                value={remotePort}
                onChange={(event) => setRemotePort(event.target.value)}
                style={{ ...styles.port, width: 72 }}
                inputMode="numeric"
                placeholder="3306"
              />
            </div>
          </>
        )}
        <button type="submit" disabled={busy} style={styles.submit}>
          {busy ? "启动中…" : "添加并启动"}
        </button>
        {error && <div style={styles.error}>{error}</div>}
      </form>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    width: 340,
    height: "100%",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    background: colors.panel,
    color: colors.text,
    borderLeft: `1px solid ${colors.border}`,
    fontFamily: "system-ui, sans-serif",
  },
  header: {
    height: 48,
    padding: "0 14px",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottom: `1px solid ${colors.border}`,
    fontSize: 15,
  },
  close: {
    border: 0,
    background: "transparent",
    color: colors.text,
    fontSize: 23,
    cursor: "pointer",
    lineHeight: 1,
  },
  list: { flex: 1, overflowY: "auto", padding: 10 },
  empty: {
    padding: "28px 8px",
    color: colors.muted,
    textAlign: "center",
    fontSize: 13,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 54,
    padding: "7px 4px",
    borderBottom: `1px solid ${colors.border}`,
  },
  badge: {
    width: 21,
    height: 21,
    borderRadius: 4,
    color: "var(--ui-panelAlt)",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontWeight: 700,
    fontSize: 12,
    flexShrink: 0,
  },
  details: { minWidth: 0, flex: 1 },
  description: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12,
  },
  state: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 4,
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  dot: { width: 6, height: 6, borderRadius: "50%", display: "inline-block" },
  smallButton: {
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    background: colors.input,
    color: colors.text,
    padding: "3px 6px",
    cursor: "pointer",
    fontSize: 11,
  },
  delete: {
    border: 0,
    background: "transparent",
    color: colors.muted,
    cursor: "pointer",
    fontSize: 18,
    padding: 3,
  },
  form: { borderTop: `1px solid ${colors.border}`, padding: 12 },
  formTitle: {
    fontSize: 12,
    color: colors.accent,
    marginBottom: 8,
    fontWeight: 600,
  },
  label: {
    display: "block",
    fontSize: 11,
    color: colors.muted,
    margin: "8px 0 4px",
  },
  inline: { display: "flex", gap: 5 },
  field: {
    minWidth: 0,
    boxSizing: "border-box",
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    background: colors.input,
    color: colors.text,
    padding: "7px 8px",
    outline: "none",
    fontSize: 12,
  },
  port: {
    boxSizing: "border-box",
    border: `1px solid ${colors.border}`,
    borderRadius: 3,
    background: colors.input,
    color: colors.text,
    padding: "7px 6px",
    outline: "none",
    fontSize: 12,
  },
  submit: {
    width: "100%",
    marginTop: 12,
    border: 0,
    borderRadius: 3,
    background: colors.accent,
    color: "var(--ui-panelAlt)",
    padding: "8px 10px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: 12,
  },
  error: {
    color: "var(--ui-danger)",
    fontSize: 11,
    marginTop: 7,
    wordBreak: "break-word",
  },
};
