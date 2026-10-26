import { defaultSettings } from "../store";
import { loadLookupSettings, TASK_LOOKUP_KEY, TASK_LOOKUP_EVENT, defaultLookupSettings, clearBoardCache } from "./taskLookup";

const DEFAULTS: Record<string, string> = {
  [TASK_LOOKUP_KEY]: JSON.stringify(defaultLookupSettings()),
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
  "dssh.panel-side.team": "right",
  "dssh.panel-side.collaboration": "right",
  "dssh.collaboration.v2": "{}",
  "dssh.team-connections.v1": "{}",
};
export function collectSyncUi(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(DEFAULTS).map(([key, value]) => [
      key,
      (key === TASK_LOOKUP_KEY ? JSON.stringify(loadLookupSettings()) : localStorage.getItem(key)) ??
        (key === "dssh.settings" ? JSON.stringify(defaultSettings()) : value),
    ]),
  );
}
export function restoreSyncUi(values: Record<string, string>): void {
  // Retired local AI settings in older bundles are ignored, not restored.
  const entries = Object.entries(values).filter(([key]) => key !== "dssh.team-ai.v1" && key !== "dssh.team-ai.profiles.v1");
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
    entries.forEach(([key, value]) => {
      if (key === TASK_LOOKUP_KEY) {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) delete parsed.overrides;
        localStorage.setItem(key,JSON.stringify(parsed));
      } else localStorage.setItem(key,value);
    });
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
  window.dispatchEvent(new Event("dssh-collaboration-changed"));
  if (Object.prototype.hasOwnProperty.call(values, TASK_LOOKUP_KEY)) {
    clearBoardCache();
    window.dispatchEvent(new Event(TASK_LOOKUP_EVENT));
  }
}
export interface SyncRestoreResult {
  message: string;
  uiState: Record<string, string>;
  legacy: boolean;
}
