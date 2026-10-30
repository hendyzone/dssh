/** Selected terminal text → a remote file path for the 「下载」 context-menu item. */

export interface RemoteDownloadCandidate {
  /** Absolute POSIX path after resolving against the pane cwd. */
  path: string;
  /** Last path segment, used as the transfer label. */
  name: string;
}

const BAD = /[\x00-\x08\x0b-\x1f\x7f]/;

/** First line only; surrounding quotes/backticks and trailing tool punctuation are not part of a path. */
export function selectedPathText(selection: string): string {
  const line = selection.split(/\r?\n/).map(value => value.trim()).find(Boolean) ?? "";
  if (!line || BAD.test(line)) return "";
  let value = line;
  for (const [open, close] of [['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"]] as const) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
      value = value.slice(open.length, -close.length).trim();
      break;
    }
  }
  value = value.replace(/[，。；：！？、;,]+$/, "");
  // Shell syntax and URLs are not file paths; a stat would just fail, but never guess them.
  if (!value || /[|&;$*?\r\n\t]/.test(value) || /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value) || value.startsWith("~")) return "";
  return value;
}

function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

/** Absolute input is used as-is (normalized); relative input is resolved against the pane cwd. */
export function downloadCandidate(selection: string, cwd: string | undefined): RemoteDownloadCandidate | null {
  const value = selectedPathText(selection);
  if (!value) return null;
  let path: string;
  if (value.startsWith("/")) {
    if (value.startsWith("//")) return null;
    path = normalizeAbsolute(value);
  } else {
    if (!cwd || !cwd.startsWith("/")) return null;
    path = normalizeAbsolute(`${cwd.replace(/\/+$/, "")}/${value}`);
  }
  if (path === "/") return null;
  const name = path.split("/").pop()!;
  return name ? {path, name} : null;
}

export function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return "/" + parts.join("/");
}

export interface RemoteEntry { name?: unknown; path?: unknown; isDir?: unknown; is_dir?: unknown }

/** True only for an existing non-directory entry at the exact path. */
export function isRemoteFile(entries: RemoteEntry[] | null | undefined, path: string): boolean {
  const entry = (entries ?? []).find(item => item && item.path === path);
  if (!entry) return false;
  return entry.isDir !== true && entry.is_dir !== true;
}
