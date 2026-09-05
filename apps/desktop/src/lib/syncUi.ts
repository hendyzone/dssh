import { defaultSettings } from "../store";

const DEFAULTS: Record<string, string> = {
  "dssh.settings": "",
  "dssh.sftp.hidden": "true",
  "dssh.sftp.application": "",
  "dssh.sidebar.width": "264",
  "dssh.sidebar.collapsed-groups": "[]",
  "dssh.sidebar.tree-layout": '{"folders":[],"order":{}}',
  "dssh.panel-side.tmux": "right",
  "dssh.panel-side.sftp": "right",
  "dssh.panel-side.forward": "right",
  "dssh.panel-side.tasks": "right",
  "dssh.panel-side.changes": "right",
  "dssh.panel-side.monitor": "right",
};
export function collectSyncUi(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, value]) => [
      key,
      localStorage.getItem(key) ??
        (key === "dssh.settings" ? JSON.stringify(defaultSettings()) : value),
    ]),
  );
}
export function restoreSyncUi(values: Record<string, string>): void {
  const entries = Object.entries(values);
  if (
    entries.some(
      ([key, value]) =>
        !Object.prototype.hasOwnProperty.call(DEFAULTS, key) ||
        typeof value !== "string",
    )
  )
    throw new Error("界面备份包含不支持的配置");
  const old = entries.map(([key]) => [key, localStorage.getItem(key)] as const);
  try {
    entries.forEach(([key, value]) => localStorage.setItem(key, value));
  } catch (error) {
    old.forEach(([key, value]) => {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch {}
    });
    throw error;
  }
  window.dispatchEvent(new Event("dssh-panel-position"));
}
export interface SyncRestoreResult {
  message: string;
  uiState: Record<string, string>;
  legacy: boolean;
}
