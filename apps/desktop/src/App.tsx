import AdventurePanel from "./components/AdventurePanel";
import { useTeamService } from "./lib/teamService";
import { AppDialog } from "./components/ui/app-dialog";
import { PositionedMenu, MenuItem } from "./components/ui/positioned-menu";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import TasksPanel, { useTasks } from "./components/TasksPanel";
import { useClaudeStatus, claudeTaskId, type ClaudeHost } from "./lib/claudeStatus";
import { useAiStatus, aiTaskId } from "./lib/aiStatus";
import { invoke } from "@tauri-apps/api/core";
import ChangesPanel from "./components/ChangesPanel";
import { focusTask, focusTmuxPane, taskLabels } from "./lib/taskStatus";
import { useTmuxProgramStatus } from "./lib/tmuxProgramStatus";
import IconRail from "./components/IconRail";
import { placePanel, railPanels, settingsLayout, setPanelHidden, setPanelSide, type PanelId, type PanelSide } from "./lib/sidePanelLayout";
import CollaborationPanel from "./components/CollaborationPanel";
import TeamPanel from "./components/TeamPanel";
import { useOfficeMail } from "./lib/useOfficeMail";
import { officeActiveProject, type OfficeMailDirectory } from "./lib/teamOffice";
import { useTeamOffice } from "./lib/useTeamOffice";
import { useOfficePublisher, openOfficeWindow, useMainWindowVisibility, useOfficePresence } from "./lib/officeWindowSync";
import QuotaPanel, { type QuotaServer } from "./components/QuotaPanel";
import { collaborationKey, useActiveCollaboration, useCollaboration } from "./lib/collaboration";
import { boardSource, inferProject, useLookupSettings, type TeamLookupScope } from "./lib/taskLookup";
import { connectedMemberTab, type TeamMember } from "./lib/teamMembers";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWindowClose } from "./lib/useWindowClose";
import { loadWorkspace, saveWorkspace } from "./lib/workspaceRestore";
import { confirmAction } from "./lib/confirm";
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
import PaneMemberStatus from "./components/PaneMemberStatus";
import TerminalTaskLayer from "./components/TerminalTaskLayer";
import LinuxTitleBar, { linuxTitleBar } from "./components/LinuxTitleBar";
import { LOCAL_SHELL, isLocalShell } from "./lib/localShell";
import TmuxPanel from "./components/TmuxPanel";
import { findTmuxTab } from "./lib/tmuxTabs";
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
import UpdatePrompt from "./components/UpdatePrompt";
import { useAppUpdate } from "./lib/useAppUpdate";
import SftpPanel from "./components/SftpPanel";
import Sidebar from "./components/Sidebar";
import {
  loadRecentConnections,
  sortByRecentConnections,
  rememberConnection,
} from "./lib/recentConnections";
import { useDetachedTabs, canDetach, hiddenTab, saveDetachedPreviews, loadDetachedPreviews, type TabDescriptor } from "./lib/detachedTabs";
import { finishTabDrag } from "./lib/tabDetachDrag";
import { ReopenedPreview } from "./components/DetachedTabWindow";
import TerminalView from "./components/TerminalView";
import WebPageView from "./components/WebPageView";
import FileBookmarks from "./components/FileBookmarks";
import { bookmarkId, loadBookmarks, removeBookmark, saveBookmarks, toggleBookmark, pageTarget,
  type FileBookmark } from "./lib/bookmarks";
import type { PageTarget, WebPage } from "./lib/webPages";
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
  | "adventure"
  | "team"
  | "collaboration"
  | "sftp"
  | "forward"
  | "tmux"
  | "tasks"
  | "changes"
  | "monitor"
  | "quota"
  | null;
type ContextMenu = { tabId: string; x: number; y: number };

export default function App() {
  const collaborationProfiles = useCollaboration();
  const teamService = useTeamService();
  const serviceTeamsEnabled = !!teamService.url && teamService.projects.length > 0;
  const appUpdate = useAppUpdate();
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
  const [workspaceTabs, setTabs] = useState<TabInfo[]>([]);
  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [connectionGroups, setConnectionGroups] = useState<ConnectionGroup[]>(
    [],
  );
  const [groupEditor, setGroupEditor] = useState<{
    groupId?: string;
    tabId?: string;
  } | null>(null);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const detached = useDetachedTabs();
  const tabs=useMemo(()=>workspaceTabs.filter(tab=>!hiddenTab(detached.entries,tab.id)),[workspaceTabs,detached.entries]);
  const dragCancelled = useRef(false);
  const [webPages, setWebPages] = useState<WebPage[]>([]);
  // Web previews are transient: never persist page contents or stale SSH handles.
  const displayTabs: TabInfo[] = [...tabs, ...webPages.map(page => ({
    id: page.id, customTitle: page.title, panes: [], activePane: 0,
  }))].filter(tab=>!hiddenTab(detached.entries,tab.id));
  const openPage = (target: PageTarget, sessionId: string) => {
    const existing = webPages.find(page => page.sessionId === sessionId &&
      JSON.stringify(page.target) === JSON.stringify(target));
    if (existing) { setActiveTabId(existing.id); return; }
    const id = crypto.randomUUID();
    const title = target.kind !== "url" ? target.path.split("/").pop()! : new URL(target.url).hostname;
    setWebPages(previous => [...previous, { id, title, target, sessionId, server: tabs.flatMap(t=>t.panes).find(p=>backendIds[p.id]===sessionId)?.server }]);
    setActiveTabId(id);
  };
  const closePage = (id: string) => {
    if(detached.entries.some(e=>e.descriptor.sourceId===id))return;
    setWebPages(previous => previous.filter(page => page.id !== id));
    if (activeTabId === id) setActiveTabId(webPages.filter(page => page.id !== id).at(-1)?.id ?? tabs.at(-1)?.id ?? null);
  };
  // 远程文件书签：只存本机 localStorage（服务器 id + 远端绝对路径），不同步。
  const [bookmarks, setBookmarks] = useState<FileBookmark[]>(() => loadBookmarks());
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [bookmarkError, setBookmarkError] = useState("");
  const [pageMenu, setPageMenu] = useState<{pageId: string; x: number; y: number} | null>(null);
  const [pendingBookmark, setPendingBookmark] = useState<{serverId: string; target: PageTarget} | null>(null);
  const updateBookmarks = (next: FileBookmark[]) => { setBookmarks(next); saveBookmarks(next); };
  /** 窗格 id → 后端 SSH session_id（连接建立后回填） */
  const [backendIds, setBackendIds] = useState<Record<string, string | null>>(
    {},
  );
  /** A preview tab's SSH backend → the server it belongs to (bookmarks are per server, not per backend). */
  const pageServerId = (page: WebPage) =>
    page.server?.id ?? tabs.flatMap(tab => tab.panes).find(pane => backendIds[pane.id] === page.sessionId)?.server.id;
  const pageBookmark = (page: WebPage) => {
    const target = page.target;
    if (target.kind === "url") return undefined;
    const serverId = pageServerId(page);
    return serverId ? bookmarks.find(bookmark => bookmark.serverId === serverId && bookmark.path === target.path) : undefined;
  };
  const togglePageBookmark = (page: WebPage) => {
    if (page.target.kind === "url") return;
    const serverId = pageServerId(page);
    if (!serverId) return;
    const server = servers.find(item => item.id === serverId);
    updateBookmarks(toggleBookmark(bookmarks, {
      serverId, serverName: server?.name ?? serverId, kind: page.target.kind,
      path: page.target.path, title: page.target.path.split("/").pop() || page.target.path,
    }));
  };
  /** 每个标签页打开的侧面板 */
  const taskStates = useTasks();
  const claudeHosts = new Map<string, ClaudeHost>();
  const tmuxHosts = new Map<string, ClaudeHost>();
  tabs.forEach(tab => tab.panes.forEach(pane => {
    const sessionId = backendIds[pane.id];
    if (sessionId && !tmuxHosts.has(pane.server.id)) tmuxHosts.set(pane.server.id, {serverId:pane.server.id, name:pane.server.name, sessionId});
    if (isLocalShell(pane.server)) return;
    if (sessionId && !claudeHosts.has(pane.server.id)) claudeHosts.set(pane.server.id, {serverId:pane.server.id, name:pane.server.name, sessionId});
  }));
  const quotaServers: QuotaServer[] = [...claudeHosts.values()].map(host => ({ id: host.serverId, name: host.name, sessionId: host.sessionId }));
  const aiSnapshots = useAiStatus([...claudeHosts.values()], tabs.flatMap(tab => tab.panes), backendIds);
  const tmuxProgramSnapshots = useTmuxProgramStatus([...tmuxHosts.values()]);
  const claudeSnapshots = useClaudeStatus([...claudeHosts.values()], Object.entries(aiSnapshots).flatMap(([serverId, snapshot]) =>
    snapshot.tasks.filter(task => task.provider === "claude" && task.tmux).map(task => ({ serverId, id: task.tmux!.id, created: task.tmux!.created }))));
  const [taskNavigationError, setTaskNavigationError] = useState<string | null>(null);
  const taskNavigation = useRef(0);
  const navigationContext = useRef({ tabs, activeTabId, tmuxHosts, backendIds });
  navigationContext.current = { tabs, activeTabId, tmuxHosts, backendIds };
  useEffect(() => () => { taskNavigation.current++; }, []);
  const lastTmuxFocusSnapshot = useRef<unknown>();
  const activeTaskTab = tabs.find(tab => tab.id === activeTabId);
  const activeTaskPane = activeTaskTab?.panes[activeTaskTab.activePane];
  useEffect(() => {
    // Changing tabs does not acknowledge a pane using an old server snapshot.
    lastTmuxFocusSnapshot.current = activeTaskPane && tmuxProgramSnapshots[activeTaskPane.server.id];
    focusTmuxPane(activeTaskPane?.id ?? "");
    window.dispatchEvent(new Event("dssh-tmux-ps-refresh"));
  }, [activeTaskPane?.id]);
  useEffect(() => {
    const pane = activeTaskPane;
    const snapshot = pane && tmuxProgramSnapshots[pane.server.id];
    if (!pane?.tmux || !snapshot?.supported || snapshot.error || document.hidden || !document.hasFocus() ||
      snapshot === lastTmuxFocusSnapshot.current) return;
    lastTmuxFocusSnapshot.current = snapshot;
    const remote = snapshot.panes.find(item => item.sessionId === pane.tmux!.id && item.sessionCreated === pane.tmux!.created && item.windowActive && item.paneActive);
    focusTmuxPane(pane.id, remote ? { serverId: pane.server.id, sessionId: remote.sessionId,
      sessionCreated: remote.sessionCreated, sessionName: remote.sessionName, paneId: remote.paneId } : undefined);
  }, [tmuxProgramSnapshots, activeTaskPane]);
  useEffect(() => {
    const tab = tabs.find(item => item.id === activeTabId);
    const pane = tab?.panes[tab.activePane];
    if (!pane?.tmux || document.hidden || !document.hasFocus()) return;
    if (tmuxProgramSnapshots[pane.server.id]?.supported && !tmuxProgramSnapshots[pane.server.id]?.error) return;
    const remote = pane.tmux;
    const ai = aiSnapshots[pane.server.id]?.tasks.find(task => task.active && task.tmux?.id === remote.id && task.tmux?.created === remote.created);
    if (ai) { focusTask(aiTaskId(pane.server.id, ai.id)); return; }
    const task = claudeSnapshots[pane.server.id]?.tasks.find(item => item.tmux?.id === pane.tmux?.id);
    if (task) focusTask(claudeTaskId(pane.server.id, task.id));
  }, [claudeSnapshots, aiSnapshots, tmuxProgramSnapshots, activeTabId, tabs]);
  const selectTask = (id: string) => {
    const navigation = ++taskNavigation.current;
    setTaskNavigationError(null);
    const native = taskStates.find(task => task.id === id && task.protocolScope === "tmux-pane");
    if (native?.tmux) {
      const target = native.tmux;
      const host = tmuxHosts.get(target.serverId);
      const server = target.serverId === LOCAL_SHELL.id ? LOCAL_SHELL : servers.find(item => item.id === target.serverId);
      if (!host || !server) { setTaskNavigationError("tmux 会话当前不可用，请连接对应终端后重试。"); return; }
      const remote = { id: target.sessionId, created: target.sessionCreated, name: target.sessionName };
      const originalView = findTmuxTab(tabs, server, remote, activeTabId);
      void invoke("tmux_action", { sessionId: host.sessionId, request: {
        action: "select-pane", session: { id: remote.id, created: remote.created }, target: target.paneId,
      } }).then(() => {
        const latest = navigationContext.current;
        if (navigation !== taskNavigation.current) return;
        if (latest.tmuxHosts.get(host.serverId)?.sessionId !== host.sessionId ||
          (originalView && !latest.tabs.some(tab => tab.panes.some(pane => pane.id === originalView.tab.panes[originalView.paneIndex].id)))) {
          setTaskNavigationError("来源连接或目标终端已变化，请重试。"); return;
        }
        const existing = findTmuxTab(latest.tabs, server, remote, latest.activeTabId);
        if (existing) {
          setActiveTabId(existing.tab.id); focusPane(existing.tab.id, existing.paneIndex);
          setConnectionGroups(groups => groups.map(group => group.id === existing.tab.groupId ? { ...group, collapsed: false } : group));
          if (latest.backendIds[existing.tab.panes[existing.paneIndex].id]) focusTask(id);
        } else connect(server, undefined, remote);
        window.dispatchEvent(new Event("dssh-tmux-ps-refresh"));
      }).catch(error => { if (navigation === taskNavigation.current) setTaskNavigationError(`无法打开 tmux 窗格：${String(error)}`); });
      return;
    }
    if (id.startsWith("tmux-ps:")) { setTaskNavigationError("该 tmux 状态已失效，请刷新后重试。"); return; }
    if (id.startsWith("ai:")) {
      for (const host of claudeHosts.values()) {
        const task = aiSnapshots[host.serverId]?.tasks.find(item => aiTaskId(host.serverId, item.id) === id);
        if (!task) continue;
        const server = servers.find(item => item.id === host.serverId);
        if (!server) return;
        if (task.tmux) {
          // Verify the incarnation and pane membership before changing remote focus.
          const remote = task.tmux;
          const originalView = findTmuxTab(tabs, server, remote, activeTabId);
          void invoke("tmux_action", { sessionId: host.sessionId, request: {
            action: "select-pane", session: { id: remote.id, created: remote.created }, target: remote.pane,
          } }).then(() => {
            const latest = navigationContext.current;
            if (navigation !== taskNavigation.current) return;
            if (latest.tmuxHosts.get(host.serverId)?.sessionId !== host.sessionId ||
              (originalView && !latest.tabs.some(tab => tab.panes.some(pane => pane.id === originalView.tab.panes[originalView.paneIndex].id)))) {
              setTaskNavigationError("来源连接或目标终端已变化，请重试。"); return;
            }
            const existing = findTmuxTab(latest.tabs, server, remote, latest.activeTabId);
            if (existing) {
              setActiveTabId(existing.tab.id); focusPane(existing.tab.id, existing.paneIndex);
              setConnectionGroups(groups => groups.map(group => group.id === existing.tab.groupId ? { ...group, collapsed: false } : group));
              if (latest.backendIds[existing.tab.panes[existing.paneIndex].id]) focusTask(id);
            }
            else connect(server, undefined, remote);
          }).catch(error => { if (navigation === taskNavigation.current) setTaskNavigationError(`无法打开 AI 窗格：${String(error)}`); });
        } else {
          const tab = tabs.find(item => item.panes.some(pane => pane.id === task.paneId && pane.server.id === host.serverId));
          if (tab) {
            setActiveTabId(tab.id); focusPane(tab.id, tab.panes.findIndex(pane => pane.id === task.paneId)); focusTask(id);
            setConnectionGroups(groups => groups.map(group => group.id === tab.groupId ? { ...group, collapsed: false } : group));
          }
          else setTaskNavigationError("来源终端已关闭，无法跳转到旧的 AI 会话。");
        }
        return;
      }
      setTaskNavigationError("AI 会话当前不可用，请连接对应服务器后重试。");
      return;
    }
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
    const sourcePaneId = taskStates.find(task => task.id === id)?.sourcePaneId ?? id;
    const tab = tabs.find((t) => t.panes.some((p) => p.id === sourcePaneId));
    if (tab) {
      setActiveTabId(tab.id);
      focusPane(
        tab.id,
        tab.panes.findIndex((p) => p.id === sourcePaneId),
      );
      focusTask(id);
      setConnectionGroups(groups => groups.map(group => group.id === tab.groupId ? { ...group, collapsed: false } : group));
    }
  };
  const selectTaskRef = useRef(selectTask);
  selectTaskRef.current = selectTask;
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<unknown>).detail;
      if (typeof id === "string") selectTaskRef.current(id);
    };
    window.addEventListener("dssh-open-task", open);
    return () => window.removeEventListener("dssh-open-task", open);
  }, []);
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

  const closeError = useWindowClose(Object.values(backendIds).some(Boolean), detached.entries.length>0);

  useEffect(() => {
    let disposed = false;
    applyTheme(getTheme(settings.themeId));
    loadServers()
      .then(async loaded => {
        if (disposed) return;
        setServers(loaded);
        try {
          const saved = loadWorkspace(loaded);
          const previews=loadDetachedPreviews(loaded);
          setWebPages(previews.flatMap(d=>d.kind==="preview"?[{...d.page,sessionId:""}]:[]));
          for(const descriptor of previews) await invoke("tab_restore_preview",{descriptor});
          if(disposed)return;
          setTabs(saved.tabs);
          setActiveTabId(saved.activeTabId);
          setConnectionGroups(saved.groups);
          setPaneCwds(saved.cwds);
          setWorkspaceReady(true);
        } catch (error) {
          setWorkspaceError(`工作现场恢复失败，原记录已保留，本次不会覆盖：${String(error)}`);
        }
      })
      .catch((e) => {
        if (!disposed) setWorkspaceError(`加载服务器列表失败，未恢复工作现场：${String(e)}`);
      });
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateSettings = (next: AppSettings) => {
    setSettings(next);
    saveSettings(next);
  };
  // Left and right rails share one layout: side, order and visibility per panel.
  const panelLayout = useMemo(() => settingsLayout(settings), [settings.panelLayout]);
  const updateLayout = (next: typeof panelLayout) => updateSettings({...settings, panelLayout: next});
  const movePanel = (id: PanelId, side: PanelSide, index: number) => updateLayout(placePanel(panelLayout, id, side, index));
  const movePanelToSide = (id: PanelId, side: PanelSide) => {
    if (panelLayout[id].side !== side) updateLayout(placePanel(panelLayout, id, side, 9999));
  };
  const [connectionsOpen, setConnectionsOpen] = useState(true);

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
  useEffect(() => {
    // Never overwrite the saved workspace with the initial empty render.
    if (!workspaceReady) return;
    try {
      saveWorkspace({ tabs: workspaceTabs, activeTabId, groups: connectionGroups, cwds: paneCwds });
      setWorkspaceError(null);
    } catch (error) {
      setWorkspaceError(`工作现场保存失败：${String(error)}`);
    }
  }, [workspaceReady, workspaceTabs, activeTabId, connectionGroups, paneCwds]);
  useEffect(()=>{
    if(workspaceReady)try{saveDetachedPreviews(detached.entries);}catch(error){setWorkspaceError(String(error));}
  },[workspaceReady,detached.entries]);
  const collaborationPane=tabs.find(t=>t.id===activeTabId)?.panes[tabs.find(t=>t.id===activeTabId)?.activePane??0];
  const activeCollaboration=useActiveCollaboration(collaborationProfiles,collaborationPane,backendIds[collaborationPane?.id??""],paneCwds[collaborationPane?.id??""]);
  const lookupSettings = useLookupSettings();
  const [activeTeamLookup, setActiveTeamLookup] = useState<{paneId:string;scope:TeamLookupScope}>();
  const onLookupScopeChange = useCallback((paneId:string,scope?:TeamLookupScope) => {
    setActiveTeamLookup(current => scope ? (current?.paneId===paneId && current.scope.key===scope.key ? current : {paneId,scope})
      : current?.paneId===paneId ? undefined : current);
  },[]);
  const officeMainVisible = useMainWindowVisibility();
  const officeExists = useOfficePresence();
  const [inlineRoomOpen, setInlineRoomOpen] = useState(false);
  const officeMailDirectory = useRef<OfficeMailDirectory>(new Map());
  const officeSessions = tabs.flatMap(tab=>tab.panes.map(pane=>({pane,backendId:backendIds[pane.id]??""})));
  const officeRoomSnapshot = useTeamOffice({profiles:collaborationProfiles, servers,
    sessions:officeSessions,
    programSnapshots:tmuxProgramSnapshots, lookupSettings, themeId:settings.themeId,
    animationEnabled:settings.teamAvatarAnimation !== false, enabled:(inlineRoomOpen || officeExists) && officeMainVisible, officeExists, mailDirectoryRef:officeMailDirectory});
  const officeMail = useOfficeMail({profiles:collaborationProfiles,servers,sessions:officeSessions,enabled:(inlineRoomOpen || officeExists) && officeMainVisible,directory:officeMailDirectory});
  const activeOfficeProject = officeActiveProject(collaborationPane, teamService);
  const officeSnapshot = useMemo(()=>({...officeRoomSnapshot,mail:officeMail,activeProject:activeOfficeProject}),[officeRoomSnapshot,officeMail,activeOfficeProject]);
  useOfficePublisher(officeSnapshot, officeExists);
  const paneTaskContext = (pane: SessionInfo) => ({
    source: boardSource(lookupSettings),
    inferred: inferProject(lookupSettings,pane,teamService,
      activeTeamLookup?.paneId===pane.id && collaborationPane?.id===pane.id && ["team","collaboration"].includes(sidePanels[activeTabId??""]??"") ? activeTeamLookup.scope : undefined),
  });
  // Status bar member: a card opened from it (same overlay as terminal task links) and the member
  // to locate once the team panel is open.
  const [statusTask, setStatusTask] = useState<{tabId: string; project: string; code: string; seq: number} | null>(null);
  const toggleTaskDetail = useCallback((tabId: string, project: string, code: string) => {
    setStatusTask(prev =>
      prev?.tabId === tabId && prev.project === project && prev.code === code
        ? null
        : { tabId, project, code, seq: (prev?.seq ?? 0) + 1 },
    );
  }, []);
  const [teamFocus, setTeamFocus] = useState<{paneId: string; project: string; key: string; seq: number}>();
  const statusBoard = boardSource(lookupSettings);
  const paneTaskLinks = (pane: SessionInfo) => {
    if (!lookupSettings.terminalLinks) return undefined;
    const { source, inferred } = paneTaskContext(pane);
    return source && inferred ? { source, project: inferred.project } : undefined;
  };
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
    tmuxWorkdir?: string,
  ) => {
    // 每点一次开一个新连接（同一服务器可开任意多个标签）
    if (!isLocalShell(server)) setRecentIds((previous) => rememberConnection(previous, server.id));
    const pane: SessionInfo = { id: crypto.randomUUID(), server, tmux, tmuxWorkdir };
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

  /** Reopen by the saved server and path; reuse any live SSH connection, otherwise connect first. */
  const openBookmark = (bookmark: FileBookmark) => {
    setBookmarkError("");
    const server = servers.find(item => item.id === bookmark.serverId);
    if (!server) { setBookmarkError(`服务器已不存在：${bookmark.serverName}`); return; }
    const target = pageTarget(bookmark);
    const existing = webPages.find(page => page.target.kind !== "url" &&
      page.target.path === bookmark.path && pageServerId(page) === server.id);
    if (existing) { setActiveTabId(existing.id); setBookmarksOpen(false); return; }
    const pane = tabs.flatMap(tab => tab.panes).find(item => item.server.id === server.id && backendIds[item.id]);
    if (pane) { openPage(target, backendIds[pane.id]!); setBookmarksOpen(false); return; }
    setPendingBookmark({serverId: server.id, target});
    setBookmarksOpen(false);
    connect(server);
  };
  useEffect(() => {
    if (!pendingBookmark) return;
    const pane = tabs.flatMap(tab => tab.panes)
      .find(item => item.server.id === pendingBookmark.serverId && backendIds[item.id]);
    if (!pane) return;
    openPage(pendingBookmark.target, backendIds[pane.id]!);
    setPendingBookmark(null);
  }, [pendingBookmark, tabs, backendIds]);
  const hasActiveConnection = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId);
    return tab?.panes.some((pane) => Boolean(backendIds[pane.id])) ?? false;
  };

  const openTeamMember = async (member: TeamMember, server: ServerEntry, groupId?: string) => {
    const existing = await connectedMemberTab(member, server, tabs, backendIds, activeTabId);
    if (existing) {
      setActiveTabId(existing.tab.id);
      focusPane(existing.tab.id, existing.paneIndex);
      if (existing.tab.groupId) setConnectionGroups(previous => previous.map(group =>
        group.id === existing.tab.groupId ? {...group, collapsed:false} : group));
      return;
    }
    // TerminalView authenticates using this device's saved connection and checks the
    // tmux incarnation and worktree before attaching, including on reconnect.
    connect(server, groupId, member.tmux, member.workdir);
  };

  const confirmClose = async (tabIds: string[], message: string) => {
    const hasActiveSession = tabIds.some(hasActiveConnection);
    return !hasActiveSession || await confirmAction(message);
  };

  const removeTabs = (tabIds: string[], focusTabId?: string) => {
    const ids = new Set(tabIds.filter(id=>!detached.entries.some(e=>e.descriptor.sourceId===id)));
    if(!ids.size)return;
    const removedPaneIds = tabs
      .filter((tab) => ids.has(tab.id))
      .flatMap((tab) => tab.panes.map((pane) => pane.id));
    setTabs((prev) => {
      const next = prev.filter((tab) => !ids.has(tab.id));
      if (focusTabId && next.some((tab) => tab.id === focusTabId)) {
        setActiveTabId(focusTabId);
      } else if (activeTabId && ids.has(activeTabId)) {
        setActiveTabId(next[next.length - 1]?.id ?? webPages.at(-1)?.id ?? null);
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
    removeTabs([tabId]);
  };

  const closePane = async (tabId: string, paneIndex: number) => {
    const tab = tabs.find((item) => item.id === tabId);
    if (!tab) return;
    const pane = tab.panes[paneIndex];
    if (!pane) return;
    if (
      backendIds[pane.id] &&
      !(await confirmAction("此窗格仍有终端会话运行中，确定要关闭吗？"))
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
    connect(tab.panes[0].server, tab.groupId, tab.panes[0].tmux, tab.panes[0].tmuxWorkdir);
    setContextMenu(null);
  };

  const closeOtherTabs = async (tabId: string) => {
    const ids = tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id);
    if (!(await confirmClose(ids, "其他标签仍有终端会话运行中，确定要关闭吗？")))
      return;
    removeTabs(ids, tabId);
    setContextMenu(null);
  };

  const closeTabsToRight = async (tabId: string) => {
    const index = tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const ids = tabs.slice(index + 1).map((tab) => tab.id);
    if (!(await confirmClose(ids, "右侧标签仍有终端会话运行中，确定要关闭吗？")))
      return;
    removeTabs(ids, tabId);
    setContextMenu(null);
  };

  // ---- 分屏 ----

  const splitTab = (tabId: string, dir: "row" | "column") => {
    if(detached.entries.some(e=>e.descriptor.sourceId===tabId))return;
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
          tmuxWorkdir: src.tmuxWorkdir,
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
        if (displayTabs.length > 1) {
          const index = displayTabs.findIndex((tab) => tab.id === activeTabId);
          const step = event.shiftKey ? -1 : 1;
          setActiveTabId(displayTabs[(index + step + displayTabs.length) % displayTabs.length].id);
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "w") {
        if (webPages.some(page => page.id === activeTabId)) { closePage(activeTabId!); return; }
        if (activeTabId) {
          const tab = tabs.find((item) => item.id === activeTabId);
          if (tab) closePane(tab.id, tab.activePane);
        }
      } else if (key === "t") {
        setServerPickerOpen(true);
      } else if (/^[1-9]$/.test(event.key)) {
        const tab = displayTabs[Number(event.key) - 1];
        if (tab) setActiveTabId(tab.id);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeTabId,
    webPages,
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
  const closeConnectionGroup = async (id: string) => {
    const ids = tabs.filter((t) => t.groupId === id).map((t) => t.id);
    if (
      !(await confirmClose(
        ids,
        "此分组仍有终端会话运行中，确定要关闭组内全部连接吗？",
      ))
    )
      return;
    removeTabs(ids);
    setConnectionGroups((prev) => prev.filter((g) => g.id !== id));
    setGroupEditor(null);
  };
  const detachTab = (id: string, position?: {x:number;y:number}) => {
    if(detached.entries.some(e=>e.descriptor.sourceId===id))return;
    const tab=tabs.find(t=>t.id===id), page=webPages.find(p=>p.id===id);
    let descriptor:TabDescriptor;
    if(page && (page.target.kind==="url" || page.server)) {
      const {sessionId: _sessionId, ...reference}=page;
      descriptor={kind:"preview",sourceId:id,page:reference,settings};
    } else if(canDetach(tab)) descriptor={kind:"terminal",sourceId:id,tab:tab!,settings};
    else return;
    void detached.open(descriptor,position);
  };
  const endDetachDrag = (id:string) => void finishTabDrag(dragCancelled.current,position=>detachTab(id,position)).catch(()=>{});
  useEffect(()=>{
    if(activeTabId && hiddenTab(detached.entries,activeTabId)) setActiveTabId(displayTabs[0]?.id??null);
    const returning=detached.entries.find(e=>e.phase==="returning");
    if(returning)setActiveTabId(returning.descriptor.sourceId);
  },[detached.entries]);
  useEffect(()=>{
    const cancel=(e:KeyboardEvent)=>{if(e.key==="Escape")dragCancelled.current=true;};
    window.addEventListener("keydown",cancel,true);return()=>window.removeEventListener("keydown",cancel,true);
  },[]);
  useEffect(()=>{
    const strip=document.querySelector(".workspace-tab-header");
    if(!strip)return;
    const report=()=>{const r=strip.getBoundingClientRect();void invoke("tab_drop_zone",{zone:{x:r.x,y:r.y,width:r.width,height:r.height}}).catch(()=>{});};
    report();const observer=new ResizeObserver(report);observer.observe(strip);
    window.addEventListener("resize",report);
    return()=>{observer.disconnect();window.removeEventListener("resize",report);};
  });
  const renderTab = (t: TabInfo) => {
    const page = webPages.find(item => item.id === t.id);
    if (page) {
      const saved = pageBookmark(page);
      return <div key={page.id} role="tab" tabIndex={0} draggable
      onDragStart={event=>{dragCancelled.current=false;event.dataTransfer.setData("application/x-dssh-tab",page.id);}}
      onDragEnd={()=>endDetachDrag(page.id)}
      aria-selected={page.id === activeTabId} className={`tab ${page.id === activeTabId ? "active" : ""}`}
      onClick={() => setActiveTabId(page.id)}
      onKeyDown={event => {
        if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault(); setActiveTabId(page.id);
        }
      }}
      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); closePage(page.id); } }}
      onContextMenu={event => { event.preventDefault(); setPageMenu({pageId: page.id, x: event.clientX, y: event.clientY}); }}>
      {page.target.kind !== "url" && <Button variant="ghost" size="icon-sm" className={`tab-bookmark${saved ? " is-on" : ""}`}
        aria-label={saved ? "取消收藏" : "收藏"} title={saved ? "取消收藏" : "收藏"}
        onClick={event => { event.stopPropagation(); togglePageBookmark(page); }}>{saved ? "★" : "☆"}</Button>}
      <span title={page.title}>🌐 {page.title}</span>
      <Button variant="ghost" size="icon-sm" aria-label={`关闭网页 ${page.title}`}
        onClick={event => { event.stopPropagation(); closePage(page.id); }}><IconClose size={12}/></Button>
    </div>;
    }
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
        onDragEnd={()=>endDetachDrag(t.id)}
        onDragStart={(event) => {
          dragCancelled.current=false;
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

  const railTab = tabs.find(tab => tab.id === activeTabId);
  const railLocal = railTab ? isLocalShell(railTab.panes[railTab.activePane].server) : false;
  const railPanel = sidePanels[activeTabId ?? ""] ?? null;
  const railTeamAvailable = serviceTeamsEnabled || (!railLocal && !!railTab?.panes[railTab.activePane]?.tmux);
  const railCollaborationAvailable = !!activeCollaboration?.enabled &&
    (activeCollaboration.taskboardEnabled || activeCollaboration.mailEnabled);
  const railAvailable = (id: PanelId) => {
    if (id === "connections") return true;
    if (!railTab) return false;
    if (railLocal && !["tmux", "tasks", "collaboration", "team", "adventure"].includes(id)) return false;
    if ((id === "team" || id === "adventure") && !railTeamAvailable) return false;
    if (id === "collaboration" && !railCollaborationAvailable) return false;
    return true;
  };
  const railActiveOn = (side: PanelSide) => connectionsOpen && panelLayout.connections.side === side
    ? "connections"
    : railPanel && panelLayout[railPanel]?.side === side ? railPanel : null;
  const rail = (side: PanelSide) => <IconRail side={side}
    items={railPanels(panelLayout, side).filter(item => railAvailable(item.id))}
    active={railActiveOn(side)}
    onSelect={id => { if (id === "connections") { setConnectionsOpen(open => !open); return; } if (activeTabId) togglePanel(activeTabId, id); }}
    onMove={movePanel}/>;
  const connectionsPanel = !panelLayout.connections.hidden && connectionsOpen
    ? <Sidebar recentIds={recentIds} key={sidebarRevision} servers={servers} onConnect={connect}
        onAdd={(group) => { setNewServerGroup(group); setFormTarget(undefined); }}
        onImport={() => setShowImport(true)} onEdit={(s) => setFormTarget(s)}
        onDelete={removeServer} onServersChanged={setServers} onOpenSettings={() => setShowSettings(true)}
        onHide={() => setConnectionsOpen(false)}/>
    : null;

  return (
    <div className={`app${linuxTitleBar ? " has-linux-titlebar" : ""}`}>
      <LinuxTitleBar />
      {workspaceError && <div role="alert">{workspaceError}</div>}
      {taskNavigationError && <div role="alert">{taskNavigationError}</div>}
      {closeError && (
        <div className="window-close-error" role="alert">
          {closeError}
        </div>
      )}
      {rail("left")}
      {panelLayout.connections.side === "left" && connectionsPanel &&
        <div className="connections-dock connections-dock-left">{connectionsPanel}</div>}
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
            tabs={displayTabs}
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
          <Button variant="ghost" size="icon-sm" className="file-bookmarks-entry" aria-label="文件书签"
            aria-expanded={bookmarksOpen} title="文件书签" onClick={() => { setBookmarkError(""); setBookmarksOpen(open => !open); }}>
            <span aria-hidden="true">{bookmarks.length ? "★" : "☆"}</span>
          </Button>
          {bookmarksOpen && <FileBookmarks bookmarks={bookmarks} servers={servers} error={bookmarkError}
            onOpen={openBookmark}
            onRemove={bookmark => updateBookmarks(removeBookmark(bookmarks, bookmark.id))}
            onClose={() => setBookmarksOpen(false)}/>}
          {activeTabId && tabs.some(tab => tab.id === activeTabId) && (
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
        {detached.error && <p role="alert">独立窗口：{detached.error}</p>}
        {webPages.filter(p=>!hiddenTab(detached.entries,p.id)).map(page => detached.returnedPreviews[page.id]
          ? <ReopenedPreview key={page.id} id={detached.returnedPreviews[page.id]} page={page} active={page.id===activeTabId} onStatus={s=>detached.state(page.id,s)}/>
          : <WebPageView key={page.id} page={page} active={page.id === activeTabId}/>)}
        {tabs.length === 0 && webPages.length === 0 ? (
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
            <Button variant="outline" size="sm" onClick={() => connect(LOCAL_SHELL)}>打开本地终端</Button>
          </div>
        ) : (
          tabs.filter(t=>!hiddenTab(detached.entries,t.id)).map((t) => {
            const local = isLocalShell(t.panes[t.activePane].server);
            const requestedPanel = sidePanels[t.id] ?? null;
            const panel = local && !["tmux", "tasks", "collaboration", "team", "adventure"].includes(requestedPanel ?? "") ? null : requestedPanel;
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
                  <div
                    className="panes"
                    style={{
                      flexDirection: t.splitDir === "column" ? "column" : "row",
                    }}
                  >
                    {statusTask?.tabId === t.id && statusBoard && (
                      <TerminalTaskLayer
                        source={statusBoard}
                        project={statusTask.project}
                        hover={null}
                        opened={{ code: statusTask.code, seq: statusTask.seq }}
                        onClose={() => setStatusTask(null)}
                      />
                    )}
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
                          onStateChange={(id,state)=>{setPaneState(id,state);detached.state(t.id,state);}}
                          onCwdChange={setPaneCwd}
                          taskLinks={paneTaskLinks(p)}
                          onOpenPage={openPage}
                        />
                      </div>
                    ))}
                  </div>
                  {panel === "monitor" && (
                    <PanelDock kind="monitor" side={panelLayout.monitor.side} onSideChange={next => movePanelToSide("monitor", next)}>
                      <aside
                        className="monitor-dock"
                        id={"monitor-dock-" + t.id}
                      />
                    </PanelDock>
                  )}
                  {panel === "quota" && (
                    <PanelDock kind="quota" side={panelLayout.quota.side} onSideChange={next => movePanelToSide("quota", next)}>
                      <QuotaPanel
                        servers={quotaServers}
                        currentId={t.panes[t.activePane]?.server.id}
                        visible={t.id === activeTabId}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                  {panel === "tasks" && (
                    <PanelDock kind="tasks" side={panelLayout.tasks.side} onSideChange={next => movePanelToSide("tasks", next)}>
                      <TasksPanel
                        sessionId={activePaneBackend ?? undefined}
                        serverName={t.panes[t.activePane]?.server.name}
                        statusError={[aiSnapshots[t.panes[t.activePane]?.server.id]?.error, tmuxProgramSnapshots[t.panes[t.activePane]?.server.id]?.error].filter(Boolean).join("；")}
                        onClose={() => togglePanel(t.id, null)}
                        onSelect={selectTask}
                      />
                    </PanelDock>
                  )}
                  {panel === "adventure" && t.id === activeTabId && <PanelDock kind="adventure" side={panelLayout.adventure.side} onSideChange={next => movePanelToSide("adventure", next)}>
                    <AdventurePanel service={teamService} servers={servers} sessions={officeSessions}
                      onOpen={(member, server) => openTeamMember(member, server, t.groupId)}
                      onClose={() => togglePanel(t.id, null)}/>
                  </PanelDock>}
                  {panel === "team" && t.id === activeTabId && (serviceTeamsEnabled || t.panes[t.activePane]?.tmux) && <PanelDock kind="team" side={panelLayout.team.side} onSideChange={next => movePanelToSide("team", next)}>
                    <TeamPanel onLookupScopeChange={onLookupScopeChange} officeSnapshot={officeSnapshot} officeVisible={officeMainVisible} onRoomOpenChange={setInlineRoomOpen} onPopOut={openOfficeWindow} key={`${t.panes[t.activePane].id}:${activePaneBackend}`} sessionId={activePaneBackend ?? ""} pane={t.panes[t.activePane]} profile={collaboration}
                      focusMember={teamFocus?.paneId === t.panes[t.activePane].id ? teamFocus : undefined} onFocused={() => setTeamFocus(undefined)} taskLookup={paneTaskContext(t.panes[t.activePane])} onOpenTaskDetail={(project, code) => toggleTaskDetail(t.id, project, code)} onClose={()=>togglePanel(t.id,null)} navigation={{server:t.panes[t.activePane].server, servers, sessions:officeSessions, onOpen:(member, server)=>openTeamMember(member, server, t.groupId)}}/>
                  </PanelDock>}
                  {panel === "collaboration" && collaboration?.enabled && t.id === activeTabId && (
                    <PanelDock kind="collaboration" side={panelLayout.collaboration.side} onSideChange={next => movePanelToSide("collaboration", next)}>
                      <CollaborationPanel lookupPaneId={t.panes[t.activePane].id} onLookupScopeChange={onLookupScopeChange} key={`${activePaneBackend}:${collaborationKey(t.panes[t.activePane].server.id,collaboration)}`} sessionId={activePaneBackend ?? ""} profile={collaboration} taskLookup={paneTaskContext(t.panes[t.activePane])} onOpenTaskDetail={(project, code) => toggleTaskDetail(t.id, project, code)} onClose={()=>togglePanel(t.id,null)} officeSnapshot={officeSnapshot} officeVisible={officeMainVisible} onRoomOpenChange={setInlineRoomOpen} onPopOut={openOfficeWindow} teamNavigation={{server:t.panes[t.activePane].server, servers, sessions:officeSessions, onOpen:(member, server)=>openTeamMember(member, server, t.groupId)}}/>
                    </PanelDock>
                  )}
                  {panel === "changes" && (
                    <PanelDock kind="changes" side={panelLayout.changes.side} onSideChange={next => movePanelToSide("changes", next)}>
                      <ChangesPanel
                        key={activePaneBackend ?? "disconnected"}
                        sessionId={activePaneBackend ?? ""}
                        cwd={paneCwds[t.panes[t.activePane]?.id ?? ""]}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                  {panel === "sftp" && (
                    <PanelDock kind="sftp" side={panelLayout.sftp.side} onSideChange={next => movePanelToSide("sftp", next)}>
                      <SftpPanel
                        paneId={t.panes[t.activePane]?.id}
                        tmuxSessionName={t.panes[t.activePane]?.tmux?.name}
                        serverId={t.panes[t.activePane]?.server.id}
                        key={activePaneBackend ?? "disconnected"}
                        sessionId={activePaneBackend ?? ""}
                        terminalCwd={paneCwds[t.panes[t.activePane]?.id ?? ""]}
                        onOpenPage={openPage}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                  {panel === "tmux" && (
                    <PanelDock kind="tmux" side={panelLayout.tmux.side} onSideChange={next => movePanelToSide("tmux", next)}>
                      <TmuxPanel
                        key={activePaneBackend ?? "disconnected"}
                        sessionId={activePaneBackend ?? ""}
                        attachedId={t.panes[t.activePane]?.tmux?.id}
                        reuseTabs={settings.reuseTmuxTabs !== false}
                        onReuseTabsChange={(enabled) => updateSettings({ ...settings, reuseTmuxTabs: enabled })}
                        onClose={() => togglePanel(t.id, null)}
                        onAttach={(remote: TmuxSession, forceNew = false) => {
                          const existing = !forceNew && settings.reuseTmuxTabs !== false
                            ? findTmuxTab(tabs, t.panes[t.activePane].server, remote, activeTabId)
                            : null;
                          if (existing) {
                            setActiveTabId(existing.tab.id);
                            focusPane(existing.tab.id, existing.paneIndex);
                            if (existing.tab.groupId) setConnectionGroups((previous) => previous.map((group) =>
                              group.id === existing.tab.groupId ? { ...group, collapsed: false } : group,
                            ));
                            return;
                          }
                          connect(t.panes[t.activePane].server, t.groupId, {
                            id: remote.id,
                            created: remote.created,
                            name: remote.name,
                          });
                        }}
                      />
                    </PanelDock>
                  )}
                  {panel === "forward" && (
                    <PanelDock kind="forward" side={panelLayout.forward.side} onSideChange={next => movePanelToSide("forward", next)}>
                      <ForwardPanel
                        sessionId={activePaneBackend ?? ""}
                        onClose={() => togglePanel(t.id, null)}
                      />
                    </PanelDock>
                  )}
                </div>
                {!local && <MonitorBar
                  backendId={activePaneBackend}
                  detailsOpen={panel === "monitor"}
                  onDetailsToggle={() => togglePanel(t.id, "monitor")}
                  targetId={"monitor-dock-" + t.id}
                  center={t.id === activeTabId ? <PaneMemberStatus
                    pane={t.panes[t.activePane]}
                    profile={collaboration}
                    board={statusBoard}
                    onOpenTask={task => setStatusTask(previous => ({ tabId: t.id, ...task, seq: (previous?.seq ?? 0) + 1 }))}
                    onOpenMember={member => {
                      setTeamFocus(previous => ({ paneId: t.panes[t.activePane].id, ...member, seq: (previous?.seq ?? 0) + 1 }));
                      setSidePanels(previous => ({ ...previous, [t.id]: "team" }));
                    }}
                  /> : undefined}
                />}
              </div>
            );
          })
        )}
      </main>
      <div className="right-rail-slot">
        {rail("right")}
        {panelLayout.connections.side === "right" && connectionsPanel &&
          <div className={`connections-dock connections-dock-right`}>{connectionsPanel}</div>}
      </div>
      {pageMenu && (() => {
        const page = webPages.find(item => item.id === pageMenu.pageId);
        if (!page) return null;
        const saved = pageBookmark(page);
        return <PositionedMenu x={pageMenu.x} y={pageMenu.y} onClose={() => setPageMenu(null)} label="文件标签操作">
          <MenuItem disabled={page.target.kind!=="url" && !page.server} onClick={()=>{detachTab(page.id);setPageMenu(null);}}>在新窗口打开</MenuItem>
          <MenuItem onClick={() => { togglePageBookmark(page); setPageMenu(null); }}>{saved ? "取消收藏" : "收藏"}</MenuItem>
          <MenuItem onClick={() => { closePage(page.id); setPageMenu(null); }}>关闭标签</MenuItem>
        </PositionedMenu>;
      })()}
      {contextMenu && (
        <PositionedMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          label="标签操作"
        >
          <MenuItem disabled={!canDetach(tabs.find(t=>t.id===contextMenu.tabId))} onClick={()=>{detachTab(contextMenu.tabId);setContextMenu(null);}}>在新窗口打开</MenuItem>
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
              移入：{group.name}
              <span
                className="connection-menu-dot"
                style={{ background: group.color }}
              />
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
            <Button variant="outline" className="server-picker-item" onClick={() => {
              connect(LOCAL_SHELL); setServerPickerOpen(false);
            }}><strong>本地终端</strong><span>在这台电脑上打开 shell</span></Button>
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
          onUpdateFound={appUpdate.presentOffer}
          onServersChanged={() => {
            setSidebarRevision((value) => value + 1);
            // 同步下载已替换磁盘上的 servers.json，重新加载内存列表
            loadServers()
              .then(setServers)
              .catch((e) => console.error("同步后刷新服务器列表失败:", e));
          }}
        />
      )}
      <UpdatePrompt
        state={appUpdate.prompt}
        onLater={appUpdate.dismiss}
        onInstall={() => void appUpdate.install()}
        onOpenRelease={appUpdate.openRelease}
      />
    </div>
  );
}
