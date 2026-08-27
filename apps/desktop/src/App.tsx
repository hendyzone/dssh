import { useCallback, useEffect, useState } from "react";
import ForwardPanel from "./components/ForwardPanel";
import MonitorBar from "./components/MonitorBar";
import ServerForm from "./components/ServerForm";
import SettingsModal from "./components/SettingsModal";
import SftpPanel from "./components/SftpPanel";
import Sidebar from "./components/Sidebar";
import TerminalView from "./components/TerminalView";
import {
  deleteServer as deleteServerCmd,
  loadServers,
  loadSettings,
  saveSettings,
  upsertServer,
} from "./store";
import { applyTheme, getTheme } from "./themes";
import type { AppSettings, ServerEntry, SessionInfo, TabInfo } from "./types";

type SidePanel = "sftp" | "forward" | null;

export default function App() {
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** 窗格 id → 后端 SSH session_id（连接建立后回填） */
  const [backendIds, setBackendIds] = useState<Record<string, string | null>>(
    {},
  );
  /** 每个标签页打开的侧面板 */
  const [sidePanels, setSidePanels] = useState<Record<string, SidePanel>>({});
  const [formTarget, setFormTarget] = useState<ServerEntry | null | undefined>(
    null,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);

  useEffect(() => {
    applyTheme(getTheme(settings.themeId));
    loadServers()
      .then(setServers)
      .catch((e) => console.error("加载服务器列表失败:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = (next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  };

  const setBackendId = useCallback(
    (paneId: string, backendId: string | null) => {
      setBackendIds((prev) => ({ ...prev, [paneId]: backendId }));
    },
    [],
  );

  // ---- 连接 / 标签页 ----

  const connect = (server: ServerEntry) => {
    // 每点一次开一个新连接（同一服务器可开任意多个标签）
    const pane: SessionInfo = { id: crypto.randomUUID(), server };
    const tab: TabInfo = {
      id: crypto.randomUUID(),
      panes: [pane],
      activePane: 0,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (tabId: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId)
        setActiveTabId(next[next.length - 1]?.id ?? null);
      return next;
    });
    setSidePanels((prev) => {
      const next = { ...prev };
      delete next[tabId];
      return next;
    });
  };

  // ---- 分屏 ----

  const splitTab = (tabId: string, dir: "row" | "column") => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        if (t.panes.length >= 2) {
          // 已分屏：切换方向即可
          return { ...t, splitDir: t.splitDir === dir ? undefined : dir };
        }
        const src = t.panes[t.activePane];
        const pane: SessionInfo = {
          id: crypto.randomUUID(),
          server: src.server,
        };
        return {
          ...t,
          panes: [...t.panes, pane],
          splitDir: dir,
          activePane: 1,
        };
      }),
    );
  };

  const focusPane = (tabId: string, index: number) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, activePane: index } : t)),
    );
  };

  const togglePanel = (tabId: string, panel: SidePanel) => {
    setSidePanels((prev) => ({
      ...prev,
      [tabId]: prev[tabId] === panel ? null : panel,
    }));
  };

  // ---- 服务器条目 ----

  const submitServer = (
    record: ServerEntry,
    password?: string,
    passphrase?: string,
  ) => {
    const wasEdit = servers.some((s) => s.id === record.id);
    upsertServer(record, password, passphrase)
      .then((saved) => {
        setServers((prev) =>
          wasEdit
            ? prev.map((s) => (s.id === saved.id ? saved : s))
            : [...prev, saved],
        );
        if (wasEdit) {
          setTabs((prev) =>
            prev.map((t) => ({
              ...t,
              panes: t.panes.map((p) =>
                p.server.id === saved.id ? { ...p, server: saved } : p,
              ),
            })),
          );
        }
        setFormTarget(null);
        if (!wasEdit) connect(saved);
      })
      .catch((e) => alert(`保存失败: ${e}`));
  };

  const removeServer = (id: string) => {
    deleteServerCmd(id)
      .then(() => {
        setServers((prev) => prev.filter((s) => s.id !== id));
        tabs
          .filter((t) => t.panes.some((p) => p.server.id === id))
          .forEach((t) => closeTab(t.id));
      })
      .catch((e) => alert(`删除失败: ${e}`));
  };

  return (
    <div className="app">
      <Sidebar
        servers={servers}
        onConnect={connect}
        onAdd={() => setFormTarget(undefined)}
        onEdit={(s) => setFormTarget(s)}
        onDelete={removeServer}
        onOpenSettings={() => setShowSettings(true)}
      />
      <main className="main-area">
        {tabs.length > 0 && (
          <div className="tab-bar">
            {tabs.map((t) => {
              // 同服务器的多个标签加 #n 序号区分
              const sameServer = tabs.filter(
                (x) => x.panes[0].server.id === t.panes[0].server.id,
              );
              const dupSuffix =
                sameServer.length > 1
                  ? ` #${sameServer.findIndex((x) => x.id === t.id) + 1}`
                  : "";
              return (
                <div
                  key={t.id}
                  className={`tab ${t.id === activeTabId ? "active" : ""}`}
                  onClick={() => setActiveTabId(t.id)}
                >
                  <span>
                    {t.panes[0].server.name}
                    {dupSuffix}
                    {t.panes.length > 1 ? ` ⊞${t.panes.length}` : ""}
                  </span>
                  <button
                    className="tab-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {tabs.length === 0 ? (
          <div className="empty-state">
            <h2>dssh</h2>
            <p>点左侧 ＋ 新建一台服务器开始</p>
          </div>
        ) : (
          tabs.map((t) => {
            const panel = sidePanels[t.id] ?? null;
            const activePaneBackend =
              backendIds[t.panes[t.activePane]?.id ?? ""] ?? null;
            return (
              <div
                key={t.id}
                className="session-body"
                hidden={t.id !== activeTabId}
              >
                <div className="session-toolbar">
                  <button
                    className={`tool-btn ${panel === "sftp" ? "on" : ""}`}
                    title="SFTP 文件面板"
                    onClick={() => togglePanel(t.id, "sftp")}
                  >
                    📁
                  </button>
                  <button
                    className={`tool-btn ${panel === "forward" ? "on" : ""}`}
                    title="端口转发"
                    onClick={() => togglePanel(t.id, "forward")}
                  >
                    ⇄
                  </button>
                  <button
                    className="tool-btn"
                    title="水平分屏"
                    onClick={() => splitTab(t.id, "row")}
                  >
                    ◫
                  </button>
                  <button
                    className="tool-btn"
                    title="垂直分屏"
                    onClick={() => splitTab(t.id, "column")}
                  >
                    ⬓
                  </button>
                </div>
                <div className="session-content">
                  <div
                    className="panes"
                    style={{
                      flexDirection: t.splitDir === "column" ? "column" : "row",
                    }}
                  >
                    {t.panes.map((p, i) => (
                      <div
                        key={p.id}
                        className={`pane ${i === t.activePane ? "focused" : ""}`}
                        onClick={() => focusPane(t.id, i)}
                      >
                        <TerminalView
                          session={p}
                          active={t.id === activeTabId && i === t.activePane}
                          settings={settings}
                          onBackendReady={setBackendId}
                        />
                      </div>
                    ))}
                  </div>
                  {panel === "sftp" && (
                    <SftpPanel
                      sessionId={activePaneBackend ?? ""}
                      onClose={() => togglePanel(t.id, null)}
                    />
                  )}
                  {panel === "forward" && (
                    <ForwardPanel
                      sessionId={activePaneBackend ?? ""}
                      onClose={() => togglePanel(t.id, null)}
                    />
                  )}
                </div>
                <MonitorBar backendId={activePaneBackend} />
              </div>
            );
          })
        )}
      </main>
      {formTarget !== null && (
        <ServerForm
          initial={formTarget}
          onSubmit={submitServer}
          onCancel={() => setFormTarget(null)}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
