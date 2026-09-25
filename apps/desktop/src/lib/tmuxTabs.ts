import type { ServerEntry, SessionInfo, TabInfo } from "../types";

export const sameSshEndpoint=(a:ServerEntry,b:ServerEntry)=>
  a.host.trim().toLowerCase()===b.host.trim().toLowerCase()&&a.port===b.port&&a.username===b.username;

/** Match the remote user and stable tmux identity, including split panes. */
export function findTmuxTab(
  tabs: TabInfo[],
  server: ServerEntry,
  remote: NonNullable<SessionInfo["tmux"]>,
  preferredTabId?: string | null,
) {
  const ordered = [...tabs].sort((a, b) => Number(b.id === preferredTabId) - Number(a.id === preferredTabId));
  for (const tab of ordered) {
    const paneIndex = tab.panes.findIndex((pane) =>
      sameSshEndpoint(pane.server,server) &&
      pane.tmux?.id === remote.id && pane.tmux.created === remote.created,
    );
    if (paneIndex !== -1) return { tab, paneIndex };
  }
  return null;
}
