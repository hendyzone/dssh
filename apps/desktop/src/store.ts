import type { ServerEntry } from './types';

const KEY = 'dssh.servers';

// 临时持久化方案：localStorage。M2 迁移到 tauri store + keyring
export function loadServers(): ServerEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as ServerEntry[]) : [];
  } catch {
    return [];
  }
}

export function saveServers(servers: ServerEntry[]): void {
  localStorage.setItem(KEY, JSON.stringify(servers));
}
