import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type ForwardType = "local" | "remote" | "dynamic";

type ForwardRule = {
  ruleType: ForwardType;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
};

type PersistentForwardRule = ForwardRule & {
  id: string;
  enabled: boolean;
  autoStart: boolean;
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

function makeRuleId(): string {
  // crypto.randomUUID 在旧 WebView 中可能不存在，时间戳足以保证本地规则 id 唯一。
  return `forward-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function rulePayload(rule: ForwardRule): ForwardRule {
  return {
    ruleType: rule.ruleType,
    localHost: rule.localHost,
    localPort: rule.localPort,
    remoteHost: rule.remoteHost,
    remotePort: rule.remotePort,
  };
}

export default function ForwardPanel({ sessionId, onClose }: Props) {
  const [rules, setRules] = useState<PersistentForwardRule[]>([]);
  const [statuses, setStatuses] = useState<ForwardStatus[]>([]);
  const [ruleType, setRuleType] = useState<ForwardType>("local");
  const [localHost, setLocalHost] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState("8080");
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState("3306");
  const [autoStart, setAutoStart] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(new Set<string>());
  const refreshing = useRef(false);

  const resetForm = useCallback(() => {
    setEditingId(null);
    setRuleType("local");
    setLocalHost("127.0.0.1");
    setLocalPort("8080");
    setRemoteHost("");
    setRemotePort("3306");
    setAutoStart(false);
  }, []);

  const refresh = useCallback(async () => {
    if (!sessionId || refreshing.current) return; // 会话尚未建立或上一次刷新还未完成
    refreshing.current = true;
    try {
      const [saved, active] = await Promise.all([
        invoke<PersistentForwardRule[]>("forward_rules_list", { sessionId }),
        invoke<ForwardStatus[]>("forward_list", { sessionId }),
      ]);
      setRules(saved);
      setStatuses(active);
      setError(null);

      // 面板打开且会话已就绪时补做自动启动；集合同时避免轮询重复启动。
      for (const item of saved) {
        if (!item.enabled || !item.autoStart) continue;
        if (active.some((status) => status.ruleId === item.id)) continue;
        const key = `${sessionId}:${item.id}`;
        if (autoStarted.current.has(key)) continue;
        autoStarted.current.add(key);
        try {
          await invoke("forward_start", {
            sessionId,
            ruleId: item.id,
            rule: rulePayload(item),
          });
        } catch (reason) {
          setError(String(reason));
        }
      }
      if (saved.some((item) => item.enabled && item.autoStart)) {
        setStatuses(await invoke<ForwardStatus[]>("forward_list", { sessionId }));
      }
    } catch (reason) {
      setError(String(reason));
    } finally {
      refreshing.current = false;
    }
  }, [sessionId]);

  useEffect(() => {
    autoStarted.current.clear();
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

  const start = async (item: PersistentForwardRule) => {
    if (!sessionId) {
      setError("会话尚未建立，稍候再试");
      return;
    }
    try {
      await invoke("forward_start", {
        sessionId,
        ruleId: item.id,
        rule: rulePayload(item),
      });
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const saveRules = async (next: PersistentForwardRule[]) => {
    const saved = await invoke<PersistentForwardRule[]>("forward_rules_save", {
      sessionId,
      rules: next,
    });
    setRules(saved);
    return saved;
  };

  const validateForm = (): ForwardRule | null => {
    const parsedLocalPort = Number(localPort);
    const parsedRemotePort = Number(remotePort);
    if (
      !localHost.trim() ||
      !Number.isInteger(parsedLocalPort) ||
      parsedLocalPort < 1 ||
      parsedLocalPort > 65535
    ) {
      setError("请输入有效的本地地址和端口");
      return null;
    }
    if (
      ruleType !== "dynamic" &&
      (!remoteHost.trim() ||
        !Number.isInteger(parsedRemotePort) ||
        parsedRemotePort < 1 ||
        parsedRemotePort > 65535)
    ) {
      setError("请输入有效的远程地址和端口");
      return null;
    }
    return {
      ruleType,
      localHost: localHost.trim(),
      localPort: parsedLocalPort,
      remoteHost: remoteHost.trim(),
      remotePort: ruleType === "dynamic" ? 0 : parsedRemotePort,
    };
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const rule = validateForm();
    if (!rule || !sessionId) {
      if (!sessionId) setError("会话尚未建立，稍候再试");
      return;
    }
    setBusy(true);
    try {
      const id = editingId ?? makeRuleId();
      const old = rules.find((item) => item.id === id);
      const wasRunning = statuses.some(
        (status) => status.ruleId === id && status.running,
      );
      const next: PersistentForwardRule[] = rules.some((item) => item.id === id)
        ? rules.map((item) =>
            item.id === id
              ? { ...item, ...rule, autoStart, enabled: item.enabled }
              : item,
          )
        : [...rules, { ...rule, id, enabled: true, autoStart }];

      // 编辑运行中的规则时先停后启，避免旧监听端口继续占用。
      if (old && wasRunning) await invoke("forward_stop", { ruleId: id });
      await saveRules(next);
      if (!old || wasRunning) {
        await invoke("forward_start", {
          sessionId,
          ruleId: id,
          rule: rulePayload(rule),
        });
      }
      resetForm();
      await refresh();
      setError(null);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const edit = (item: PersistentForwardRule) => {
    setEditingId(item.id);
    setRuleType(item.ruleType);
    setLocalHost(item.localHost);
    setLocalPort(String(item.localPort));
    setRemoteHost(item.remoteHost);
    setRemotePort(String(item.remotePort || 3306));
    setAutoStart(item.autoStart);
    setError(null);
  };

  const remove = async (item: PersistentForwardRule) => {
    setBusy(true);
    try {
      if (statuses.some((status) => status.ruleId === item.id && status.running)) {
        await invoke("forward_stop", { ruleId: item.id });
      }
      await saveRules(rules.filter((rule) => rule.id !== item.id));
      if (editingId === item.id) resetForm();
      await refresh();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleAutoStart = async (item: PersistentForwardRule) => {
    try {
      await saveRules(
        rules.map((rule) =>
          rule.id === item.id ? { ...rule, autoStart: !rule.autoStart } : rule,
        ),
      );
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <aside className="forward-panel" style={styles.panel}>
      <header style={styles.header}>
        <strong>端口转发</strong>
        <button type="button" onClick={onClose} style={styles.close} aria-label="关闭">
          ×
        </button>
      </header>

      <div style={styles.list}>
        {rules.length === 0 ? (
          <div style={styles.empty}>暂无转发规则</div>
        ) : (
          rules.map((item) => {
            const info = typeInfo[item.ruleType];
            const running = statuses.some(
              (status) => status.ruleId === item.id && status.running,
            );
            const description =
              item.ruleType === "remote"
                ? `${endpoint(item.remoteHost, item.remotePort)} → ${endpoint(item.localHost, item.localPort)}`
                : item.ruleType === "dynamic"
                  ? `${endpoint(item.localHost, item.localPort)} → SOCKS5`
                  : `${endpoint(item.localHost, item.localPort)} → ${endpoint(item.remoteHost, item.remotePort)}`;
            return (
              <div key={item.id} style={styles.row}>
                <span style={{ ...styles.badge, background: info.color }}>{info.short}</span>
                <div style={styles.details}>
                  <div style={styles.description} title={info.label}>{description}</div>
                  <div style={styles.state}>
                    <span style={{ ...styles.dot, background: running ? "#9ece6a" : "var(--ui-danger)" }} />
                    {running ? "运行中" : "已停止"}
                  </div>
                </div>
                <button
                  type="button"
                  style={styles.smallButton}
                  disabled={busy}
                  onClick={() => (running ? void stop(item.id) : void start(item))}
                >
                  {running ? "停止" : "启动"}
                </button>
                <button type="button" style={styles.smallButton} disabled={busy} onClick={() => edit(item)}>
                  编辑
                </button>
                <button type="button" style={styles.delete} disabled={busy} onClick={() => void remove(item)} aria-label="删除">
                  ×
                </button>
                <label style={styles.autoStart} title="连接后自动启动">
                  <input type="checkbox" checked={item.autoStart} onChange={() => void toggleAutoStart(item)} />
                  自动
                </label>
              </div>
            );
          })
        )}
      </div>

      <form onSubmit={save} style={styles.form}>
        <div style={styles.formTitle}>{editingId ? "编辑转发规则" : "添加并启动"}</div>
        <select value={ruleType} onChange={(event) => setRuleType(event.target.value as ForwardType)} style={styles.field}>
          <option value="local">本地转发</option>
          <option value="remote">远程转发</option>
          <option value="dynamic">动态 SOCKS5</option>
        </select>
        <label style={styles.label}>本地地址:端口</label>
        <div style={styles.inline}>
          <input value={localHost} onChange={(event) => setLocalHost(event.target.value)} style={{ ...styles.field, flex: 1 }} placeholder="127.0.0.1" />
          <input value={localPort} onChange={(event) => setLocalPort(event.target.value)} style={{ ...styles.port, width: 72 }} inputMode="numeric" placeholder="8080" />
        </div>
        {ruleType !== "dynamic" && (
          <>
            <label style={styles.label}>远程地址:端口</label>
            <div style={styles.inline}>
              <input value={remoteHost} onChange={(event) => setRemoteHost(event.target.value)} style={{ ...styles.field, flex: 1 }} placeholder="远程主机" />
              <input value={remotePort} onChange={(event) => setRemotePort(event.target.value)} style={{ ...styles.port, width: 72 }} inputMode="numeric" placeholder="3306" />
            </div>
          </>
        )}
        <label style={styles.checkbox}>
          <input type="checkbox" checked={autoStart} onChange={(event) => setAutoStart(event.target.checked)} />
          连接后自动启动
        </label>
        <div style={styles.formButtons}>
          <button type="submit" disabled={busy} style={styles.submit}>{busy ? "保存中…" : editingId ? "保存并应用" : "添加并启动"}</button>
          {editingId && <button type="button" disabled={busy} style={styles.cancel} onClick={resetForm}>取消</button>}
        </div>
        {error && <div style={styles.error}>{error}</div>}
      </form>
    </aside>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: { width: 340, height: "100%", boxSizing: "border-box", display: "flex", flexDirection: "column", background: colors.panel, color: colors.text, borderLeft: `1px solid ${colors.border}`, fontFamily: "system-ui, sans-serif" },
  header: { height: 48, padding: "0 14px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: `1px solid ${colors.border}`, fontSize: 15 },
  close: { border: 0, background: "transparent", color: colors.text, fontSize: 23, cursor: "pointer", lineHeight: 1 },
  list: { flex: 1, overflowY: "auto", padding: 10 },
  empty: { padding: "28px 8px", color: colors.muted, textAlign: "center", fontSize: 13 },
  row: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 7, minHeight: 54, padding: "7px 4px", borderBottom: `1px solid ${colors.border}` },
  badge: { width: 21, height: 21, borderRadius: 4, color: "var(--ui-panelAlt)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flexShrink: 0 },
  details: { minWidth: 0, flex: 1 },
  description: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12 },
  state: { color: colors.muted, fontSize: 11, marginTop: 4, display: "flex", alignItems: "center", gap: 4 },
  dot: { width: 6, height: 6, borderRadius: "50%", display: "inline-block" },
  smallButton: { border: `1px solid ${colors.border}`, borderRadius: 3, background: colors.input, color: colors.text, padding: "3px 6px", cursor: "pointer", fontSize: 11 },
  delete: { border: 0, background: "transparent", color: colors.muted, cursor: "pointer", fontSize: 18, padding: 3 },
  autoStart: { width: "100%", color: colors.muted, fontSize: 11, paddingLeft: 28, cursor: "pointer" },
  form: { borderTop: `1px solid ${colors.border}`, padding: 12 },
  formTitle: { fontSize: 12, color: colors.accent, marginBottom: 8, fontWeight: 600 },
  label: { display: "block", fontSize: 11, color: colors.muted, margin: "8px 0 4px" },
  inline: { display: "flex", gap: 5 },
  field: { minWidth: 0, boxSizing: "border-box", border: `1px solid ${colors.border}`, borderRadius: 3, background: colors.input, color: colors.text, padding: "7px 8px", outline: "none", fontSize: 12 },
  port: { boxSizing: "border-box", border: `1px solid ${colors.border}`, borderRadius: 3, background: colors.input, color: colors.text, padding: "7px 6px", outline: "none", fontSize: 12 },
  checkbox: { display: "flex", alignItems: "center", gap: 5, color: colors.muted, fontSize: 11, marginTop: 10 },
  formButtons: { display: "flex", gap: 7, marginTop: 12 },
  submit: { flex: 1, border: 0, borderRadius: 3, background: colors.accent, color: "var(--ui-panelAlt)", padding: "8px 10px", cursor: "pointer", fontWeight: 600, fontSize: 12 },
  cancel: { border: `1px solid ${colors.border}`, borderRadius: 3, background: colors.input, color: colors.text, padding: "8px 10px", cursor: "pointer", fontSize: 12 },
  error: { color: "var(--ui-danger)", fontSize: 11, marginTop: 7, wordBreak: "break-word" },
};
