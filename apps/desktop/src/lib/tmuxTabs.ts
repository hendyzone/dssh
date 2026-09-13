import type { ServerEntry, SessionInfo, TabInfo } from "../types";

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
      pane.server.host.trim().toLowerCase() === server.host.trim().toLowerCase() &&
      pane.server.port === server.port &&
      pane.server.username === server.username &&
      pane.tmux?.id === remote.id && pane.tmux.created === remote.created,
    );
    if (paneIndex !== -1) return { tab, paneIndex };
  }
  return null;
}
