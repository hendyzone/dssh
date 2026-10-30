import type { PageTarget } from "./webPages";

/** Local file bookmarks for remote preview tabs. Never synced, never sent to a server. */
export interface FileBookmark {
  /** Stable identity: same server + same remote path is the same bookmark. */
  id: string;
  serverId: string;
  /** Saved at creation so a deleted server still has a readable name. */
  serverName: string;
  kind: "html" | "markdown" | "image";
  path: string;
  /** Display name (last path segment). */
  title: string;
  addedAt: number;
}

export const BOOKMARKS_KEY = "dssh.file-bookmarks.v1";
const MAX_BOOKMARKS = 200;
const KINDS = new Set(["html", "markdown", "image"]);
const clean = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);

/** Stable, storage-safe identity (a NUL separator would trip the control-character guard). */
export function bookmarkId(serverId: string, path: string): string {
  let hash = 2166136261;
  for (const character of `${serverId}\u0000${path}`) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619) >>> 0;
  return `${hash.toString(36)}-${path.length}`;
}

/** Ignore malformed or hostile storage instead of crashing the window. */
export function loadBookmarks(): FileBookmark[] {
  try {
    const raw = JSON.parse(localStorage.getItem(BOOKMARKS_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is FileBookmark => Boolean(item) && typeof item === "object" &&
      clean(item.id, 1024) && clean(item.serverId, 200) && clean(item.serverName, 255) &&
      KINDS.has(item.kind) && clean(item.path, 4096) && item.path.startsWith("/") && !item.path.startsWith("//") &&
      clean(item.title, 255) && Number.isSafeInteger(item.addedAt)).slice(0, MAX_BOOKMARKS)
      .map(({id, serverId, serverName, kind, path, title, addedAt}) => ({id, serverId, serverName, kind, path, title, addedAt}));
  } catch { return []; }
}

export function saveBookmarks(list: FileBookmark[]): void {
  try { localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list.slice(0, MAX_BOOKMARKS))); } catch { /* storage is optional */ }
}

export function findBookmark(list: FileBookmark[], serverId: string, path: string): FileBookmark | undefined {
  return list.find(bookmark => bookmark.serverId === serverId && bookmark.path === path);
}

export function pageTarget(bookmark: FileBookmark): PageTarget {
  return {kind: bookmark.kind, path: bookmark.path};
}

/** Add or remove one bookmark, newest first; the same server+path never duplicates. */
export function toggleBookmark(list: FileBookmark[], input: Omit<FileBookmark, "id" | "addedAt">): FileBookmark[] {
  const id = bookmarkId(input.serverId, input.path);
  if (list.some(bookmark => bookmark.id === id)) return list.filter(bookmark => bookmark.id !== id);
  return [{...input, id, addedAt: Date.now()}, ...list].slice(0, MAX_BOOKMARKS);
}

export function removeBookmark(list: FileBookmark[], id: string): FileBookmark[] {
  return list.filter(bookmark => bookmark.id !== id);
}
