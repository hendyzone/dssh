import { invoke } from "./platform/core";
import { applyTheme, getTheme } from "./themes";
import type { AppSettings, ServerEntry } from "./types";

// ---- 服务器条目：后端 JSON + keyring 持久化 ----

export async function loadServers(): Promise<ServerEntry[]> {
  return invoke<ServerEntry[]>("servers_list");
}

export async function upsertServer(
  record: ServerEntry,
  password?: string,
  passphrase?: string,
): Promise<ServerEntry> {
  return invoke<ServerEntry>("servers_upsert", {
    record,
    password: password ?? null,
    passphrase: passphrase ?? null,
  });
}

export async function deleteServer(id: string): Promise<void> {
  return invoke("servers_delete", { id });
}

// ---- 界面设置：localStorage（非敏感） ----

const SETTINGS_KEY = "dssh.settings";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw)
      return { ...defaultSettings(), ...(JSON.parse(raw) as AppSettings) };
  } catch {
    /* 损坏则用默认 */
  }
  return defaultSettings();
}

export function defaultSettings(): AppSettings {
  return {
    themeId: "tokyo-night",
    fontSize: 14,
    fontFamily: "JetBrains Mono, SF Mono, Consolas, monospace",
  };
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  applyTheme(getTheme(settings.themeId));
}
