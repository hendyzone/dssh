import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import logoUrl from "./assets/logo.png";
import ForwardPanel from "./components/ForwardPanel";
import {
  IconClose,
  IconFolder,
  IconForward,
  IconSplitH,
  IconSplitV,
} from "./components/Icons";
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
type ContextMenu = { tabId: string; x: number; y: number };

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
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);

  // 关闭窗口回调由 Tauri 保存，使用 ref 读取最新会话状态，避免监听器过期。
  const backendIdsRef = useRef(backendIds);
  const allowWindowCloseRef = useRef(false);
  backendIdsRef.current = backendIds;

  useEffect(() => {
    applyTheme(getTheme(settings.themeId));
    loadServers()
      .then(setServers)
      .catch((e) => console.error("加载服务器列表失败:", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    appWindow
      .onCloseRequested(async (event) => {
        const hasActiveSession = Object.values(backendIdsRef.current).some(
          Boolean,
        );
        if (allowWindowCloseRef.current || !hasActiveSession) return;
        event.preventDefault();
        if (window.confirm("仍有 SSH 会话连接中，确定要退出 dssh 吗？")) {
          allowWindowCloseRef.current = true;
          await appWindow.close();
        }
      })
      .then((dispose) => {
        unlisten = dispose;
      })
      .catch((e) => console.error("注册窗口关闭确认失败:", e));
    return () => unlisten?.();
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

  const hasActiveConnection = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    return tab?.panes.some((pane) => Boolean(backendIds[pane.id])) ?? false;
  };

  const confirmClose = (tabIds: string[], message: string) => {
    const hasActiveSession = tabIds.some(hasActiveConnection);
    return !hasActiveSession || window.confirm(message);
  };

  const removeTabs = (tabIds: string[], focusTabId?: string) => {
    const ids = new Set(tabIds);
    const removedPaneIds = tabs
      .filter((tab) => ids.has(tab.id))
      .flatMap((tab) => tab.panes.map((pane) => pane.id));
    setTabs((prev) => {
      const next = prev.filter((tab) => !ids.has(tab.id));
      if (focusTabId && next.some((tab) => tab.id === focusTabId)) {
        setActiveTabId(focusTabId);
      } else if (activeTabId && ids.has(activeTabId)) {
        setActiveTabId(next[next.length - 1]?.id ?? null);
      }
      return next;
    });
    setSidePanels((prev) => {
      const next = { ...prev };
      ids.forEach((id) => delete next[id]);
      return next;
    });
    setBackendIds((prev) => {
      const next = { ...prev };
      removedPaneIds.forEach((id) => delete next[id]);
      return next;
    });
  };

  const closeTab = (tabId: string) => {
    if (
      !confirmClose(
        [tabId],
        "此标签仍有 SSH 会话连接中，确定要关闭吗？",
      )
    )
      return;
    removeTabs([tabId]);
  };

  const closePane = (tabId: string, paneIndex: number) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const pane = tab.panes[paneIndex];
    if (!pane) return;
    if (
      backendIds[pane.id] &&
      !window.confirm("此窗格仍有 SSH 会话连接中，确定要关闭吗？")
    )
      return;
    if (tab.panes.length === 1) {
      // 最后一个窗格就是整个标签，避免再次弹出相同确认框。
      removeTabs([tabId]);
      return;
    }
    const panes = tab.panes.filter((_, index) => index !== paneIndex);
    setTabs((prev) =>
      prev.map((item) => {
        if (item.id !== tabId) return item;
        const activePane =
          item.activePane === paneIndex
            ? Math.min(paneIndex, panes.length - 1)
            : item.activePane > paneIndex
              ? item.activePane - 1
              : item.activePane;
        return { ...item, panes, activePane, splitDir: undefined };
      }),
    );
    setBackendIds((prev) => {
      const next = { ...prev };
      delete next[pane.id];
      return next;
    });
  };

  const renameTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    setEditingTitle(tab.customTitle ?? "");
    setEditingTabId(tabId);
    setContextMenu(null);
  };

  const saveTabTitle = (tabId: string) => {
    const title = editingTitle.trim();
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === tabId
          ? { ...tab, customTitle: title || undefined }
          : tab,
      ),
    );
    setEditingTabId(null);
  };

  const duplicateTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    connect(tab.panes[0].server);
    setContextMenu(null);
  };

  const closeOtherTabs = (tabId: string) => {
    const ids = tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id);
    if (!confirmClose(ids, "其他标签仍有 SSH 会话连接中，确定要关闭吗？"))
      return;
    removeTabs(ids, tabId);
    setContextMenu(null);
  };

  const closeTabsToRight = (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const ids = tabs.slice(index + 1).map((tab) => tab.id);
    if (!confirmClose(ids, "右侧标签仍有 SSH 会话连接中，确定要关闭吗？"))
      return;
    removeTabs(ids, tabId);
    setContextMenu(null);
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

  useEffect(() => {
    if (!contextMenu) return;
    const closeMenu = () => setContextMenu(null);
    document.addEventListener("mousedown", closeMenu);
    return () => document.removeEventListener("mousedown", closeMenu);
  }, [contextMenu]);

  // 全局快捷键：不处理复制、粘贴等文本快捷键，终端焦点也能响应本应用快捷键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (editingTabId) {
          setEditingTabId(null);
        } else if (contextMenu) {
          setContextMenu(null);
        } else if (serverPickerOpen) {
          setServerPickerOpen(false);
        }
        return;
      }
      if (event.ctrlKey && event.key === "Tab") {
        event.preventDefault();
        if (tabs.length > 1) {
          const index = tabs.findIndex((tab) => tab.id === activeTabId);
          setActiveTabId(tabs[(index + 1) % tabs.length].id);
        }
        return;
      }
      const commandKey = event.metaKey || event.ctrlKey;
      if (!commandKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "w") {
        event.preventDefault();
        if (activeTabId) {
          const tab = tabs.find((item) => item.id === activeTabId);
          if (tab) closePane(tab.id, tab.activePane);
        }
      } else if (key === "t") {
        event.preventDefault();
        setServerPickerOpen(true);
      } else if (/^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const tab = tabs[Number(event.key) - 1];
        if (tab) setActiveTabId(tab.id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeTabId, contextMenu, editingTabId, serverPickerOpen, tabs]);

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
        <div className="tab-bar">
          {tabs.map((t) => {
            // 未重命名的标签仍以服务器名和 #n 序号显示。
            const sameServer = tabs.filter(
              (x) => x.panes[0].server.id === t.panes[0].server.id,
            );
            const dupSuffix =
              sameServer.length > 1
                ? ` #${sameServer.findIndex((x) => x.id === t.id) + 1}`
                : "";
            const title =
              t.customTitle || `${t.panes[0].server.name}${dupSuffix}`;
            const isConnecting = t.panes.some(
              (pane) => !backendIds[pane.id],
            );
            return (
              <div
                key={t.id}
                className={`tab ${t.id === activeTabId ? "active" : ""}`}
                onClick={() => setActiveTabId(t.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) {
                    event.preventDefault();
                    closeTab(t.id);
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ tabId: t.id, x: event.clientX, y: event.clientY });
                }}
              >
                <span
                  className={`tab-dot ${isConnecting ? "connecting" : "connected"}`}
                  title={isConnecting ? "连接中" : "已连接"}
                />
                {editingTabId === t.id ? (
                  <input
                    className="tab-title-input"
                    value={editingTitle}
                    autoFocus
                    onChange={(event) => setEditingTitle(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") saveTabTitle(t.id);
                      if (event.key === "Escape") setEditingTabId(null);
                    }}
                  />
                ) : (
                  <span
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      renameTab(t.id);
                    }}
                  >
                    {title}
                    {t.panes.length > 1 ? ` ⊞${t.panes.length}` : ""}
                  </span>
                )}
                <button
                  className="tab-close"
                  title="关闭标签"
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(t.id);
                  }}
                >
                  <IconClose size={12} />
                </button>
              </div>
            );
          })}
          <button
            className="tab-new"
            title="新建标签 (⌘T / Ctrl+T)"
            onClick={() => setServerPickerOpen(true)}
          >
            ＋
          </button>
        </div>
        {tabs.length === 0 ? (
          <div className="welcome">
            <img src={logoUrl} alt="dssh" />
            <h2>dssh</h2>
            <p>
              稳定、好看的现代 SSH 客户端
              <br />
              支持终端内图片显示 · SFTP · 端口转发
            </p>
            <button
              className="btn-primary"
              onClick={() => setFormTarget(undefined)}
            >
              ＋ 新建服务器
            </button>
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
                    className={`icon-btn ${panel === "sftp" ? "on" : ""}`}
                    title="SFTP 文件面板"
                    onClick={() => togglePanel(t.id, "sftp")}
                  >
                    <IconFolder />
                  </button>
                  <button
                    className={`icon-btn ${panel === "forward" ? "on" : ""}`}
                    title="端口转发"
                    onClick={() => togglePanel(t.id, "forward")}
                  >
                    <IconForward />
                  </button>
                  <span className="toolbar-sep" />
                  <button
                    className="icon-btn"
                    title="左右分屏"
                    onClick={() => splitTab(t.id, "row")}
                  >
                    <IconSplitH />
                  </button>
                  <button
                    className="icon-btn"
                    title="上下分屏"
                    onClick={() => splitTab(t.id, "column")}
                  >
                    <IconSplitV />
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
                        <button
                          className="pane-close"
                          title="关闭窗格"
                          onClick={(event) => {
                            event.stopPropagation();
                            closePane(t.id, i);
                          }}
                        >
                          <IconClose size={12} />
                        </button>
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
      {contextMenu && (
        <div
          className="tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button onClick={() => renameTab(contextMenu.tabId)}>重命名</button>
          <button onClick={() => duplicateTab(contextMenu.tabId)}>
            复制此会话
          </button>
          <button onClick={() => closeOtherTabs(contextMenu.tabId)}>
            关闭其他
          </button>
          <button onClick={() => closeTabsToRight(contextMenu.tabId)}>
            关闭右侧
          </button>
          <button onClick={() => { closeTab(contextMenu.tabId); setContextMenu(null); }}>
            关闭标签
          </button>
        </div>
      )}
      {serverPickerOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={() => setServerPickerOpen(false)}
        >
          <div className="modal server-picker" onMouseDown={(event) => event.stopPropagation()}>
            <h3>新建标签</h3>
            <p className="server-picker-hint">选择一个服务器建立新会话</p>
            {servers.length === 0 ? (
              <div className="sidebar-empty">暂无服务器，请先添加服务器。</div>
            ) : (
              <div className="server-picker-list">
                {servers.map((server) => (
                  <button
                    key={server.id}
                    className="server-picker-item"
                    onClick={() => {
                      connect(server);
                      setServerPickerOpen(false);
                    }}
                  >
                    <strong>{server.name}</strong>
                    <span>
                      {server.username}@{server.host}:{server.port}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setServerPickerOpen(false)}>
                取消（Esc）
              </button>
            </div>
          </div>
        </div>
      )}
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
