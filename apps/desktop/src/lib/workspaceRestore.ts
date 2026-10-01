import type { ServerEntry, SessionInfo, TabInfo } from "../types";
import type { ConnectionGroup } from "./connectionGroups";
import { sameSshEndpoint } from "./tmuxTabs";
import { LOCAL_SHELL, isLocalShell } from "./localShell";

const KEY = "dssh.workspace.v1";
export interface Workspace {
  tabs: TabInfo[];
  activeTabId: string | null;
  groups: ConnectionGroup[];
  cwds: Record<string, string>;
}
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const validCwd = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && value.length <= 8192 && !/[\x00-\x1f\x7f]/.test(value);

/** Persist references, never credentials, private key paths or live SSH handles. */
export function saveWorkspace({ tabs, activeTabId, groups, cwds }: Workspace): void {
  localStorage.setItem(KEY, JSON.stringify({
    version: 1, activeTabId, groups,
    tabs: tabs.map(tab => ({
      id: tab.id, groupId: tab.groupId, customTitle: tab.customTitle,
      splitDir: tab.splitDir, activePane: tab.activePane,
      panes: tab.panes.map(pane => ({
        id: pane.id, serverId: pane.server.id, kind: pane.server.kind,
        endpoint: { host: pane.server.host, port: pane.server.port, username: pane.server.username },
        tmux: pane.tmux, tmuxWorkdir: pane.tmuxWorkdir,
        cwd: cwds[pane.id] ?? pane.restoreCwd,
      })),
    })),
  }));
}

/** Resolve against current saved connections; never reconnect a deleted/retargeted host. */
export function loadWorkspace(servers: ServerEntry[]): Workspace {
  const empty: Workspace = { tabs: [], activeTabId: null, groups: [], cwds: {} };
  const raw = localStorage.getItem(KEY);
  if (!raw) return empty;
  const data: unknown = JSON.parse(raw);
  if (!object(data) || data.version !== 1 || !Array.isArray(data.tabs))
    throw new Error("工作现场数据格式不受支持");
  const groups: ConnectionGroup[] = [];
  for (const g of Array.isArray(data.groups) ? data.groups : []) {
    if (object(g) && typeof g.id === "string" && typeof g.name === "string" &&
        typeof g.color === "string" && !groups.some(old => old.id === g.id))
      groups.push({ id: g.id, name: g.name, color: g.color, collapsed: g.collapsed === true });
  }
  const tabs: TabInfo[] = [];
  const cwds: Record<string, string> = {};
  const ids = new Set<string>();
  for (const tab of data.tabs) {
    if (!object(tab) || typeof tab.id !== "string" || ids.has(tab.id) || !Array.isArray(tab.panes)) continue;
    ids.add(tab.id);
    const panes: SessionInfo[] = [];
    let activePane = 0;
    for (const [index, pane] of tab.panes.slice(0, 2).entries()) {
      if (!object(pane) || typeof pane.id !== "string" || ids.has(pane.id)) continue;
      const server = pane.kind === "local" ? LOCAL_SHELL : servers.find(s => s.id === pane.serverId);
      if (!server || (!isLocalShell(server) && (!object(pane.endpoint) || typeof pane.endpoint.host !== "string" ||
          !sameSshEndpoint(server, pane.endpoint as ServerEntry)))) continue;
      if (isLocalShell(server) && (pane.tmux || pane.tmuxWorkdir)) continue;
      // An invalid tmux identity must never silently become an ordinary shell.
      if (pane.tmux !== undefined && (!object(pane.tmux) ||
          typeof pane.tmux.id !== "string" || !/^\$\d+$/.test(pane.tmux.id) ||
          !Number.isSafeInteger(pane.tmux.created) || pane.tmux.created < 0 || typeof pane.tmux.name !== "string")) continue;
      if (pane.tmuxWorkdir !== undefined && !validCwd(pane.tmuxWorkdir)) continue;
      ids.add(pane.id);
      const cwd = validCwd(pane.cwd) ? pane.cwd : undefined;
      if (cwd) cwds[pane.id] = cwd;
      if (index === tab.activePane) activePane = panes.length;
      panes.push({ id: pane.id, server,
        tmux: pane.tmux ? { id: pane.tmux.id, created: pane.tmux.created, name: pane.tmux.name } : undefined,
        tmuxWorkdir: validCwd(pane.tmuxWorkdir) ? pane.tmuxWorkdir : undefined,
        restoreCwd: cwd,
      });
    }
    if (panes.length) tabs.push({ id: tab.id, panes, activePane,
      groupId: groups.some(g => g.id === tab.groupId) ? tab.groupId : undefined,
      customTitle: typeof tab.customTitle === "string" ? tab.customTitle : undefined,
      splitDir: panes.length > 1 && (tab.splitDir === "row" || tab.splitDir === "column") ? tab.splitDir : undefined,
    });
  }
  return { tabs, groups, cwds, activeTabId: tabs.some(t => t.id === data.activeTabId) ? data.activeTabId : tabs[0]?.id ?? null };
}

/** Single-quote remote paths so shell substitutions remain literal. */
export function restoreDirectoryCommand(cwd: unknown): string {
  if (!validCwd(cwd)) return "";
  return `; cd -- '${cwd.replace(/'/g, "'\"'\"'")}' || printf '%s\\n' 'dssh: 无法恢复上次目录，保留当前目录'`;
}
