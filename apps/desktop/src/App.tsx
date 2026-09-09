import { AppDialog } from "./components/ui/app-dialog";
import { PositionedMenu, MenuItem } from "./components/ui/positioned-menu";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import TasksPanel, { useTasks } from "./components/TasksPanel";
import { useClaudeStatus, claudeTaskId, type ClaudeHost } from "./lib/claudeStatus";
import ChangesPanel from "./components/ChangesPanel";
import { focusTask, taskLabels } from "./lib/taskStatus";
import ToolRail from "./components/ToolRail";
import CollaborationPanel from "./components/CollaborationPanel";
import { collaborationKey, useActiveCollaboration, useCollaboration } from "./lib/collaboration";
import { useCallback, useEffect, useRef, useState } from "react";
import { useWindowClose } from "./lib/useWindowClose";
import { preventBrowserContextMenu } from "./lib/contextMenu";
import logoUrl from "./assets/logo.png";
import PanelDock from "./components/PanelDock";
import ForwardPanel from "./components/ForwardPanel";
import {
  IconClose,
  IconFolder,
  IconForward,
  IconSplitH,
  IconSplitV,
} from "./components/Icons";
import MonitorBar from "./components/MonitorBar";
import TmuxPanel from "./components/TmuxPanel";
import type { TmuxSession } from "./lib/tmux";
import {
  ConnectionGroupEditor,
  ConnectionTabStrip,
} from "./components/ConnectionGroups";
import {
  insertConnection,
  moveConnection,
  type ConnectionGroup,
} from "./lib/connectionGroups";
import ServerImport from "./components/ServerImport";
import ServerForm from "./components/ServerForm";
import SettingsModal from "./components/SettingsModal";
import SftpPanel from "./components/SftpPanel";
import Sidebar from "./components/Sidebar";
import {
  loadRecentConnections,
  sortByRecentConnections,
  rememberConnection,
} from "./lib/recentConnections";
import TerminalView from "./components/TerminalView";
import {
  isAppShortcut,
  isComposingKey,
  isEditableTarget,
} from "./lib/keyboard";
import { useDialogFocus } from "./lib/useDialogFocus";
import {
  deleteServer as deleteServerCmd,
  loadServers,
  loadSettings,
  saveSettings,
  upsertServer,
} from "./store";
import { applyTheme, getTheme } from "./themes";
import type { AppSettings, ServerEntry, SessionInfo, TabInfo } from "./types";

type SidePanel =
  | "collaboration"
  | "sftp"
  | "forward"
  | "tmux"
  | "tasks"
  | "changes"
  | "monitor"
  | null;
type ContextMenu = { tabId: string; x: number; y: number };

export default function App() {
  const collaborationProfiles = useCollaboration();
  useEffect(() => {
    document.addEventListener("contextmenu", preventBrowserContextMenu, true);
    return () =>
      document.removeEventListener(
        "contextmenu",
        preventBrowserContextMenu,
        true,
      );
  }, []);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [recentIds, setRecentIds] = useState(loadRecentConnections);
  const [sidebarRevision, setSidebarRevision] = useState(0);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>(
    [],
  );
  const [groupEditor, setGroupEditor] = useState<{
    groupId?: string;
    tabId?: string;
  } | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  /** 窗格 id → 后端 SSH session_id（连接建立后回填） */
  const [backendIds, setBackendIds] = useState<Record<string, string | null>>(
    {},
  );
  /** 每个标签页打开的侧面板 */
  const taskStates = useTasks();
  const claudeHosts = new Map<string, ClaudeHost>();
  tabs.forEach(tab => tab.panes.forEach(pane => {
    const sessionId = backendIds[pane.id];
    if (sessionId && !claudeHosts.has(pane.server.id)) claudeHosts.set(pane.server.id, {serverId:pane.server.id, name:pane.server.name, sessionId});
  }));
  const claudeSnapshots = useClaudeStatus([...claudeHosts.values()]);
  useEffect(() => {
    const tab = tabs.find(item => item.id === activeTabId);
    const pane = tab?.panes[tab.activePane];
    if (!pane?.tmux || document.hidden || !document.hasFocus()) return;
    const task = claudeSnapshots[pane.server.id]?.tasks.find(item => item.tmux?.id === pane.tmux?.id);
    if (task) focusTask(claudeTaskId(pane.server.id, task.id));
  }, [claudeSnapshots, activeTabId, tabs]);
  const selectTask = (id: string) => {
    if (id.startsWith("claude:")) {
      for (const tab of tabs) for (const pane of tab.panes) {
        const task = claudeSnapshots[pane.server.id]?.tasks.find(item => claudeTaskId(pane.server.id, item.id) === id);
        if (task) {
          focusTask(id);
          if (task.tmux) connect(pane.server, tab.groupId, {...task.tmux, name:task.title});
          else {setActiveTabId(tab.id); setSidePanels(old => ({...old, [tab.id]:"tasks"}));}
          return;
        }
      }
    }
    const tab = tabs.find((t) => t.panes.some((p) => p.id === id));
    if (tab) {
      setActiveTabId(tab.id);
      focusPane(
        tab.id,
        tab.panes.findIndex((p) => p.id === id),
      );
      focusTask(id);
    }
  };
  const [sidePanels, setSidePanels] = useState<Record<string, SidePanel>>({});
  const [formTarget, setFormTarget] = useState<ServerEntry | null | undefined>(
    null,
  );
  const [showImport, setShowImport] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ServerEntry | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [newServerGroup, setNewServerGroup] = useState<string>();
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const serverPickerRef = useRef<HTMLDivElement>(null);

  const [fileEditorOpen, setFileEditorOpen] = useState(false);
  useEffect(() => {
    const update = (event: Event) =>
      setFileEditorOpen((event as CustomEvent<boolean>).detail);
    window.addEventListener("dssh-file-editor", update);
    return () => window.removeEventListener("dssh-file-editor", update);
  }, []);
  const terminalInputEnabled =
    !deleteTarget &&
    !fileEditorOpen &&
    formTarget === null &&
    !showSettings &&
    !showImport &&
    !serverPickerOpen &&
    !editingTabId &&
    !contextMenu &&
    !groupEditor;

  const closeError = useWindowClose(Object.values(backendIds).some(Boolean));

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

  /** 窗格连接状态（TerminalView 上报）：connecting/connected/disconnected */
  const [paneStates, setPaneStates] = useState<
    Record<string, "connecting" | "connected" | "disconnected">
  >({});
  const setPaneState = useCallback(
    (paneId: string, state: "connecting" | "connected" | "disconnected") => {
      setPaneStates((prev) => ({ ...prev, [paneId]: state }));
    },
    [],
  );

  /** 各窗格远端 shell 的当前目录（TerminalView 经 OSC 7 上报） */
  const [paneCwds, setPaneCwds] = useState<Record<string, string>>({});
  const collaborationPane=tabs.find(t=>t.id===activeTabId)?.panes[tabs.find(t=>t.id===activeTabId)?.activePane??0];
  const activeCollaboration=useActiveCollaboration(collaborationProfiles,collaborationPane,backendIds[collaborationPane?.id??""],paneCwds[collaborationPane?.id??""]);
  const setPaneCwd = useCallback((paneId: string, cwd: string) => {
    setPaneCwds((prev) =>
      prev[paneId] === cwd ? prev : { ...prev, [paneId]: cwd },
    );
  }, []);

  // ---- 连接 / 标签页 ----

  const connect = (
    server: ServerEntry,
    groupId?: string,
    tmux?: SessionInfo["tmux"],
  ) => {
    // 每点一次开一个新连接（同一服务器可开任意多个标签）
    setRecentIds((previous) => rememberConnection(previous, server.id));
    const pane: SessionInfo = { id: crypto.randomUUID(), server, tmux };
    const tab: TabInfo = {
      id: crypto.randomUUID(),
      panes: [pane],
      activePane: 0,
      groupId,
    };
    setTabs((prev) => insertConnection(prev, tab));
    if (groupId)
      setConnectionGroups((prev) =>
        prev.map((g) => (g.id === groupId ? { ...g, collapsed: false } : g)),
      );
    setActiveTabId(tab.id);
    if (tmux) setSidePanels((prev) => ({ ...prev, [tab.id]: "tmux" }));
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
    setPaneCwds((prev) => {
      const next = { ...prev };
      removedPaneIds.forEach((id) => delete next[id]);
      return next;
    });
  };

  const closeTab = (tabId: string) => {
    if (!confirmClose([tabId], "此标签仍有 SSH 会话连接中，确定要关闭吗？"))
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
        tab.id === tabId ? { ...tab, customTitle: title || undefined } : tab,
      ),
    );
    setEditingTabId(null);
  };

  const duplicateTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    connect(tab.panes[0].server, tab.groupId, tab.panes[0].tmux);
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
          tmux: src.tmux,
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
      if (event.defaultPrevented || isComposingKey(event)) return;
      // 普通界面不执行浏览器的整页全选；编辑框和终端保留原有快捷键。
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "a" &&
        !isEditableTarget(event.target) &&
        !(
          event.target instanceof Element &&
          event.target.closest(".terminal-view")
        )
      ) {
        event.preventDefault();
        return;
      }
      // 弹窗和重命名控件自行处理 Esc；不得穿透到当前 SSH 会话。
      if (
        deleteTarget ||
        formTarget !== null ||
        showSettings ||
        showImport ||
        editingTabId ||
        groupEditor
      )
        return;
      if (event.key === "Escape") {
        if (contextMenu) {
          event.preventDefault();
          event.stopPropagation();
          setContextMenu(null);
        } else if (serverPickerOpen) {
          event.preventDefault();
          event.stopPropagation();
          setServerPickerOpen(false);
        }
        return;
      }
      if (serverPickerOpen || contextMenu) return;
      const inTerminal =
        event.target instanceof Element &&
        event.target.closest(".terminal-view");
      if (isEditableTarget(event.target) && !inTerminal) return;
      if (!isAppShortcut(event)) return;
      // 在捕获阶段消费应用快捷键，避免终端先编码成控制字符发给远端。
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey && event.key === "Tab") {
        if (tabs.length > 1) {
          const index = tabs.findIndex((tab) => tab.id === activeTabId);
          const step = event.shiftKey ? -1 : 1;
          setActiveTabId(tabs[(index + step + tabs.length) % tabs.length].id);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "w") {
        if (activeTabId) {
          const tab = tabs.find((item) => item.id === activeTabId);
          if (tab) closePane(tab.id, tab.activePane);
        }
      } else if (key === "t") {
        setServerPickerOpen(true);
      } else if (/^[1-9]$/.test(event.key)) {
        const tab = tabs[Number(event.key) - 1];
        if (tab) setActiveTabId(tab.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeTabId,
    backendIds,
    contextMenu,
    editingTabId,
    groupEditor,
    formTarget,
    deleteTarget,
    serverPickerOpen,
    showSettings,
    showImport,
    tabs,
  ]);

  // ---- 服务器条目 ----

  const submitServer = (
    record: ServerEntry,
    password?: string,
    passphrase?: string,
  ) => {
    const wasEdit = servers.some((s) => s.id === record.id);
    return upsertServer(record, password, passphrase).then((saved) => {
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
    });
  };

  const removeServer = (id: string) => {
    setDeleteError("");
    setDeleteTarget(servers.find((server) => server.id === id) ?? null);
  };

  const confirmDeleteServer = () => {
    if (!deleteTarget || deleteBusy) return;
    const id = deleteTarget.id;
    setDeleteBusy(true);
    setDeleteError("");
    deleteServerCmd(id)
      .then(() => {
        setServers((prev) => prev.filter((s) => s.id !== id));
        tabs
          .filter((t) => t.panes.some((p) => p.server.id === id))
          .forEach((t) => closeTab(t.id));
        setDeleteTarget(null);
      })
      .catch((e) => setDeleteError(`删除失败：${e}`))
      .finally(() => setDeleteBusy(false));
  };

  const moveToGroup = (tabId: string, groupId?: string) => {
    if (groupId && !connectionGroups.some((g) => g.id === groupId)) return;
    setTabs((prev) => moveConnection(prev, tabId, groupId));
    setContextMenu(null);
  };
  const saveConnectionGroup = (name: string, color: string) => {
    if (!groupEditor) return;
    if (groupEditor.groupId) {
      setConnectionGroups((prev) =>
        prev.map((g) =>
          g.id === groupEditor.groupId ? { ...g, name, color } : g,
        ),
      );
    } else {
      const id = crypto.randomUUID();
      setConnectionGroups((prev) => [
        ...prev,
        { id, name, color, collapsed: false },
      ]);
      if (groupEditor.tabId)
        setTabs((prev) => moveConnection(prev, groupEditor.tabId!, id));
    }
    setGroupEditor(null);
  };
  const dissolveGroup = (id: string) => {
    setTabs((prev) =>
      prev.map((t) => (t.groupId === id ? { ...t, groupId: undefined } : t)),
    );
    setConnectionGroups((prev) => prev.filter((g) => g.id !== id));
    setGroupEditor(null);
  };
  const closeConnectionGroup = (id: string) => {
    const ids = tabs.filter((t) => t.groupId === id).map((t) => t.id);
    if (
      !confirmClose(
        ids,
        "此分组仍有 SSH 会话连接中，确定要关闭组内全部连接吗？",
      )
    )
      return;
    removeTabs(ids);
    setConnectionGroups((prev) => prev.filter((g) => g.id !== id));
    setGroupEditor(null);
  };
  const renderTab = (t: TabInfo) => {
    // 未重命名的标签仍以服务器名和 #n 序号显示。
    const sameServer = tabs.filter(
      (x) => x.panes[0].server.id === t.panes[0].server.id,
    );
    const dupSuffix =
      sameServer.length > 1
        ? ` #${sameServer.findIndex((x) => x.id === t.id) + 1}`
        : "";
    const title =
      t.customTitle ||
      `${t.panes[0].server.name}${t.panes[0].tmux ? " · tmux " + t.panes[0].tmux.name : ""}${dupSuffix}`;
    // 任一窗格断开=断开(红)，否则任一连接中=连接中(黄)，全连上=绿
    const dotState = t.panes.some(
      (pane) => paneStates[pane.id] === "disconnected",
    )
      ? "disconnected"
      : t.panes.some((pane) => !backendIds[pane.id])
        ? "connecting"
        : "connected";
    const dotTitle =
      dotState === "disconnected"
        ? "已断开"
        : dotState === "connecting"
          ? "连接中"
          : "已连接";
    return (
      <div
        key={t.id}
        draggable={editingTabId !== t.id}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-dssh-tab", t.id);
          event.dataTransfer.effectAllowed = "move";
        }}
        role="tab"
        aria-selected={t.id === activeTabId}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            setActiveTabId(t.id);
          }
        }}
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
          setContextMenu({
            tabId: t.id,
            x: event.clientX,
            y: event.clientY,
          });
        }}
      >
        <span className={`tab-dot ${dotState}`} title={dotTitle} />
        {editingTabId === t.id ? (
          <Input
            className="tab-title-input"
            value={editingTitle}
            autoFocus
            onChange={(event) => setEditingTitle(event.target.value)}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (isComposingKey(event.nativeEvent)) return;
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
        <Button
          variant="ghost"
          size="icon-sm"
          className="tab-close"
          title="关闭标签"
          onClick={(event) => {
            event.stopPropagation();
            closeTab(t.id);
          }}
        >
          <IconClose size={12} />
        </Button>
      </div>
    );
  };

  return (
    <div className="app">
      {closeError && (
        <div className="window-close-error" role="alert">
          {closeError}
        </div>
      )}
      <Sidebar
        recentIds={recentIds}
        key={sidebarRevision}
        servers={servers}
        onConnect={connect}
        onAdd={(group) => {
          setNewServerGroup(group);
          setFormTarget(undefined);
        }}
        onImport={() => setShowImport(true)}
        onEdit={(s) => setFormTarget(s)}
        onDelete={removeServer}
        onServersChanged={setServers}
        onOpenSettings={() => setShowSettings(true)}
      />
      <main className="main-area">
        {taskStates.some((task) => task.unread) && (
          <div className="task-reminder" role="status">
            {taskStates
              .filter((task) => task.unread)
              .slice(0, 3)
              .map((task) => (
                <Button
                  variant="outline"
                  size="sm"
                  key={task.id}
                  onClick={() => selectTask(task.id)}
                >
                  {task.name} · {taskLabels[task.phase]}
                  {task.estimated ? "（推测）" : ""} →
                </Button>
              ))}
          </div>
        )}
        <div className="workspace-tab-header">
          <ConnectionTabStrip
            tabs={tabs}
            groups={connectionGroups}
            activeTabId={activeTabId}
            renderTab={renderTab}
            onToggle={(id) =>
              setConnectionGroups((prev) =>
                prev.map((g) =>
                  g.id === id ? { ...g, collapsed: !g.collapsed } : g,
                ),
              )
            }
            onEdit={(group) => {
              setContextMenu(null);
              setGroupEditor({ groupId: group.id });
            }}
            onCreate={() => setGroupEditor({ tabId: activeTabId ?? undefined })}
            onNewTab={() => setServerPickerOpen(true)}
            onMove={moveToGroup}
          />
          {activeTabId && (
            <div
              className="workspace-tab-actions"
              role="toolbar"
              aria-label="终端布局"
            >
              <Button
                variant="ghost"
                size="icon-sm"
                title="左右分屏"
                aria-label="左右分屏"
                onClick={() => splitTab(activeTabId, "row")}
              >
                <IconSplitH />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="上下分屏"
                aria-label="上下分屏"
                onClick={() => splitTab(activeTabId, "column")}
              >
                <IconSplitV />
              </Button>
            </div>
          )}
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
            <Button
              variant="default"
              size="sm"
              className="btn-primary"
              onClick={() => setFormTarget(undefined)}
            >
              ＋ 新建服务器
            </Button>
          </div>
        ) : (
          tabs.map((t) => {
            const panel = sidePanels[t.id] ?? null;
            const activePaneBackend =
              backendIds[t.panes[t.activePane]?.id ?? ""] ?? null;
            const collaboration = t.id === activeTabId ? activeCollaboration : undefined;
            return (
              <div
                key={t.id}
                className="session-body"
                hidden={t.id !== activeTabId}
              >
                <div className="session-content">
                  <ToolRail
                    side="left"
                    collaborationEnabled={!!collaboration?.enabled}
                    active={panel}
                    onSelect={(kind) => togglePanel(t.id, kind)}
                  />
                  <ToolRail
                    side="right"
                    collaborationEnabled={!!collaboration?.enabled}
                    active={panel}
                    onSelect={(kind) => togglePanel(t.id, kind)}
                  />
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
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="pane-close"
                          title="关闭窗格"
                          onClick={(event) => {
                            event.stopPropagation();
                            closePane(t.id, i);
                          }}
                        >
                          <IconClose size={12} />
                        </Button>
                        <TerminalView
                          session={p}
                          active={t.id === activeTabId && i === t.activePane}
                          inputEnabled={terminalInputEnabled}
                          settings={settings}
                          onBackendReady={setBackendId}
                          onStateChange={setPaneState}
                          onCwdChange={setPaneCwd}
                        />
                      </div>
                    ))}
                  </div>
                  {panel === "monitor" && (
                    <PanelDock kind="monitor">
                      <aside
                        className="monitor-dock"
                        id={"monitor-dock-" + t.id}
                      />
                    </PanelDock>
                  )}
                  {panel === "tasks" && (
                    <PanelDock kind="tasks">
                      <TasksPanel
                        onClose={() => togglePanel(t.id, null)}
                        onSelect={selectTask}
                      />
                    </PanelDock>
                  )}
                  {panel === "collaboration" && collaboration?.enabled && t.id === activeTabId && (
                    <PanelDock kind="collaboration">
                      <CollaborationPanel key={`${activePaneBackend}:${collaborationKey(t.panes[t.activePane].server.id,collaboration)}`} sessionId={activePaneBackend ?? ""} profile={collaboration} onClose={()=>togglePanel(t.id,null)}/>
                    </PanelDock>
                  )}
                  {panel === "changes" && (
                    <PanelDock kind="changes">
                      <ChangesPanel
                        key={activePaneBackend ?? "disconnected"}
                        sessionId={activePaneBackend ?? ""}
                        cwd={paneCwds[t.panes[t.activePane]?.id ?? ""]}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                  {panel === "sftp" && (
                    <PanelDock kind="sftp">
                      <SftpPanel
                        serverId={t.panes[t.activePane]?.server.id}
                        key={activePaneBackend ?? "disconnected"}
                        sessionId={activePaneBackend ?? ""}
                        terminalCwd={paneCwds[t.panes[t.activePane]?.id ?? ""]}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                  {panel === "tmux" && (
                    <PanelDock kind="tmux">
                      <TmuxPanel
                        key={activePaneBackend ?? "disconnected"}
                        sessionId={activePaneBackend ?? ""}
                        attachedId={t.panes[t.activePane]?.tmux?.id}
                        onClose={() => togglePanel(t.id, null)}
                        onAttach={(remote: TmuxSession) =>
                          connect(t.panes[t.activePane].server, t.groupId, {
                            id: remote.id,
                            created: remote.created,
                            name: remote.name,
                          })
                        }
                      />
                    </PanelDock>
                  )}
                  {panel === "forward" && (
                    <PanelDock kind="forward">
                      <ForwardPanel
                        sessionId={activePaneBackend ?? ""}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                </div>
                <MonitorBar
                  backendId={activePaneBackend}
                  detailsOpen={panel === "monitor"}
                  onDetailsToggle={() => togglePanel(t.id, "monitor")}
                  targetId={"monitor-dock-" + t.id}
                />
              </div>
            );
          })
        )}
      </main>
      {contextMenu && (
        <PositionedMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          label="标签操作"
        >
          <MenuItem onClick={() => renameTab(contextMenu.tabId)}>
            重命名
          </MenuItem>
          <MenuItem onClick={() => duplicateTab(contextMenu.tabId)}>
            复制此会话
          </MenuItem>
          <span className="connection-menu-label">连接分组</span>
          <MenuItem
            onClick={() => {
              setGroupEditor({ tabId: contextMenu.tabId });
              setContextMenu(null);
            }}
          >
            加入新分组…
          </MenuItem>
          {connectionGroups.map((group) => (
            <MenuItem
              key={group.id}
              disabled={
                tabs.find((t) => t.id === contextMenu.tabId)?.groupId ===
                group.id
              }
              onClick={() => moveToGroup(contextMenu.tabId, group.id)}
            >
              <span
                className="connection-menu-dot"
                style={{ background: group.color }}
              />
              移入：{group.name}
            </MenuItem>
          ))}
          {tabs.find((t) => t.id === contextMenu.tabId)?.groupId && (
            <MenuItem onClick={() => moveToGroup(contextMenu.tabId)}>
              移出分组
            </MenuItem>
          )}
          <span className="connection-menu-label">关闭连接</span>
          <MenuItem onClick={() => closeOtherTabs(contextMenu.tabId)}>
            关闭其他
          </MenuItem>
          <MenuItem onClick={() => closeTabsToRight(contextMenu.tabId)}>
            关闭右侧
          </MenuItem>
          <MenuItem
            onClick={() => {
              closeTab(contextMenu.tabId);
              setContextMenu(null);
            }}
          >
            关闭标签
          </MenuItem>
        </PositionedMenu>
      )}
      {groupEditor && (
        <ConnectionGroupEditor
          key={groupEditor.groupId ?? "new"}
          group={connectionGroups.find((g) => g.id === groupEditor.groupId)}
          onSave={saveConnectionGroup}
          onCancel={() => setGroupEditor(null)}
          onUngroup={() => {
            if (groupEditor.groupId) dissolveGroup(groupEditor.groupId);
          }}
          onCloseGroup={() => {
            if (groupEditor.groupId) closeConnectionGroup(groupEditor.groupId);
          }}
        />
      )}
      {serverPickerOpen && (
        <AppDialog title="新建标签" onClose={() => setServerPickerOpen(false)}>
          <div
            ref={serverPickerRef}
            className="modal server-picker"
            aria-labelledby="server-picker-title"
            tabIndex={-1}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h3 id="server-picker-title">新建标签</h3>
            <p className="server-picker-hint">
              选择一个服务器建立新会话 · 最近使用优先
            </p>
            {servers.length === 0 ? (
              <div className="sidebar-empty">暂无服务器，请先添加服务器。</div>
            ) : (
              <div className="server-picker-list">
                {sortByRecentConnections(servers, recentIds).map((server) => (
                  <Button
                    variant="outline"
                    size="sm"
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
                  </Button>
                ))}
              </div>
            )}
            <div className="form-actions">
              <Button
                variant="outline"
                size="sm"
                className="btn-secondary"
                onClick={() => setServerPickerOpen(false)}
              >
                取消（Esc）
              </Button>
            </div>
          </div>
        </AppDialog>
      )}
      {deleteTarget && (
        <AppDialog
          title="删除保存的连接"
          busy={deleteBusy}
          onClose={() => setDeleteTarget(null)}
        >
          <div className="modal">
            <h3>删除保存的连接？</h3>
            <p style={{ overflowWrap: "anywhere" }}>
              <strong>{deleteTarget.name}</strong>
              <br />
              {deleteTarget.username}@{deleteTarget.host}:{deleteTarget.port}
            </p>
            <p>删除后无法撤销，该连接已打开的会话也会关闭。</p>
            {deleteError && <p role="alert">{deleteError}</p>}
            <div className="form-actions">
              <Button
                autoFocus
                disabled={deleteBusy}
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={deleteBusy}
                onClick={confirmDeleteServer}
              >
                {deleteBusy ? "正在删除…" : "确认删除"}
              </Button>
            </div>
          </div>
        </AppDialog>
      )}
      {formTarget !== null && (
        <ServerForm
          initial={formTarget}
          defaultGroup={newServerGroup}
          onSubmit={submitServer}
          onCancel={() => setFormTarget(null)}
        />
      )}
      {showImport && (
        <ServerImport
          servers={servers}
          onImported={(server) =>
            setServers((prev) => [
              ...prev.filter((s) => s.id !== server.id),
              server,
            ])
          }
          onClose={() => setShowImport(false)}
        />
      )}
      {showSettings && (
        <SettingsModal
          collaborationSessions={tabs.flatMap(t=>t.panes.map(pane=>({pane,backendId:backendIds[pane.id]??""})))}
          servers={servers}
          settings={settings}
          onChange={updateSettings}
          onClose={() => setShowSettings(false)}
          onServersChanged={() => {
            setSidebarRevision((value) => value + 1);
            // 同步下载已替换磁盘上的 servers.json，重新加载内存列表
            loadServers()
              .then(setServers)
              .catch((e) => console.error("同步后刷新服务器列表失败:", e));
          }}
        />
      )}
    </div>
  );
}
