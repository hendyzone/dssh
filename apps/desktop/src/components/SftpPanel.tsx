import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number | null;
  mtime?: number | null;
  permissions?: number | null;
}

interface SftpPanelProps {
  sessionId: string;
  onClose: () => void;
}

interface DragDropPayload {
  paths: string[];
}

const panelStyle: CSSProperties = {
  boxSizing: "border-box",
  width: 320,
  height: "100%",
  minHeight: 240,
  display: "flex",
  flexDirection: "column",
  background: "var(--ui-panelAlt)",
  color: "var(--ui-fg)",
  borderLeft: "1px solid var(--ui-border)",
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};

const buttonStyle: CSSProperties = {
  border: "1px solid var(--ui-border)",
  borderRadius: 4,
  padding: "4px 7px",
  background: "var(--ui-panel)",
  color: "var(--ui-fg)",
  cursor: "pointer",
  fontSize: 12,
};

function joinRemotePath(directory: string, name: string): string {
  if (directory === "/") return `/${name}`;
  return `${directory.replace(/\/$/, "")}/${name}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

function formatSize(size: number | null | undefined, isDir: boolean): string {
  if (isDir || size == null) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatTime(mtime: number | null | undefined): string {
  if (mtime == null) return "—";
  const date = new Date(mtime * 1000);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export default function SftpPanel({ sessionId, onClose }: SftpPanelProps) {
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const currentPathRef = useRef(currentPath);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!sessionId) return; // 会话尚未建立
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<FileEntry[]>("sftp_list", {
          sessionId,
          path,
        });
        setEntries(result);
        currentPathRef.current = path;
        setCurrentPath(path);
        setSelectedPath(null);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    void loadDirectory("/");
  }, [loadDirectory, sessionId]);

  const uploadFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setError(null);
      setNotice(null);
      setUploading(paths);
      try {
        for (const localPath of paths) {
          const remotePath = joinRemotePath(
            currentPathRef.current,
            basename(localPath),
          );
          await invoke("sftp_upload", {
            sessionId,
            remotePath,
            localPath,
          });
        }
        await loadDirectory(currentPathRef.current);
      } catch (reason) {
        setError(String(reason));
      } finally {
        setUploading([]);
      }
    },
    [loadDirectory, sessionId],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const registration = listen<DragDropPayload>(
      "tauri://drag-drop",
      (event) => {
        if (!disposed) void uploadFiles(event.payload.paths ?? []);
      },
    );
    void registration.then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      disposed = true;
      unlisten?.();
      void registration.then((cleanup) => cleanup());
    };
  }, [uploadFiles]);

  const breadcrumbs = useMemo(() => {
    const parts = currentPath.split("/").filter(Boolean);
    return [
      { label: "/", path: "/" },
      ...parts.map((part, index) => ({
        label: part,
        path: `/${parts.slice(0, index + 1).join("/")}`,
      })),
    ];
  }, [currentPath]);

  const runAction = async (action: () => Promise<void>) => {
    setError(null);
    setNotice(null);
    try {
      await action();
      await loadDirectory(currentPath);
    } catch (reason) {
      setError(String(reason));
    }
  };

  const createDirectory = () => {
    const name = window.prompt("新目录名称");
    if (!name?.trim()) return;
    void runAction(async () => {
      await invoke("sftp_mkdir", {
        sessionId,
        path: joinRemotePath(currentPath, name.trim()),
      });
    });
  };

  const download = (entry: FileEntry) => {
    void (async () => {
      setError(null);
      setNotice(null);
      try {
        const localPath = await invoke<string>("sftp_download", {
          sessionId,
          remotePath: entry.path,
        });
        setNotice(`已下载到 ${localPath}`);
      } catch (reason) {
        setError(String(reason));
      }
    })();
  };

  const rename = (entry: FileEntry) => {
    const name = window.prompt("新名称", entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    void runAction(async () => {
      await invoke("sftp_rename", {
        sessionId,
        oldPath: entry.path,
        newPath: joinRemotePath(currentPath, name.trim()),
      });
    });
  };

  const remove = (entry: FileEntry) => {
    if (!window.confirm(`确定删除“${entry.name}”吗？`)) return;
    void runAction(async () => {
      await invoke("sftp_delete", {
        sessionId,
        path: entry.path,
        isDir: entry.isDir,
      });
    });
  };

  const enter = (entry: FileEntry) => {
    if (entry.isDir) void loadDirectory(entry.path);
    else download(entry);
  };

  return (
    <aside className="sftp-panel" style={panelStyle}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 10px 7px",
          borderBottom: "1px solid var(--ui-border)",
        }}
      >
        <strong style={{ color: "var(--ui-fg)", marginRight: "auto" }}>SFTP</strong>
        <button
          type="button"
          style={buttonStyle}
          onClick={() => void loadDirectory(currentPath)}
          title="刷新"
        >
          ↻
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={createDirectory}
          title="新建目录"
        >
          ＋目录
        </button>
        <button
          type="button"
          style={buttonStyle}
          onClick={onClose}
          title="关闭"
        >
          ×
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          overflowX: "auto",
          padding: "7px 10px",
          whiteSpace: "nowrap",
        }}
      >
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && (
              <span style={{ color: "var(--ui-muted)", margin: "0 3px" }}>/</span>
            )}
            <button
              type="button"
              onClick={() => void loadDirectory(crumb.path)}
              style={{
                border: 0,
                padding: 0,
                background: "transparent",
                color: index === breadcrumbs.length - 1 ? "var(--ui-accent)" : "var(--ui-fg)",
                cursor: "pointer",
              }}
            >
              {crumb.label}
            </button>
          </span>
        ))}
      </div>

      {error && (
        <div
          style={{
            margin: "0 8px 6px",
            padding: "7px 8px",
            borderRadius: 4,
            background: "#3b1f2b",
            color: "var(--ui-danger)",
            overflowWrap: "anywhere",
          }}
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          style={{
            margin: "0 8px 6px",
            padding: "7px 8px",
            borderRadius: 4,
            background: "#1d3548",
            color: "#9ece6a",
            overflowWrap: "anywhere",
          }}
        >
          {notice}
        </div>
      )}
      {uploading.length > 0 && (
        <div
          style={{
            margin: "0 8px 6px",
            padding: "7px 8px",
            borderRadius: 4,
            background: "var(--ui-border)",
            color: "var(--ui-accent)",
          }}
        >
          正在上传 {uploading.length} 个文件…
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 5px 8px" }}>
        {loading ? (
          <div style={{ padding: 14, color: "var(--ui-muted)" }}>正在读取目录…</div>
        ) : entries.length === 0 ? (
          <div style={{ padding: 14, color: "var(--ui-muted)" }}>目录为空</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => setSelectedPath(entry.path)}
              onDoubleClick={() => enter(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                setSelectedPath(entry.path);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minHeight: 42,
                padding: "4px 5px",
                borderRadius: 4,
                background:
                  selectedPath === entry.path ? "var(--ui-border)" : "transparent",
                cursor: "default",
              }}
            >
              <span style={{ fontSize: 18, width: 21 }}>
                {entry.isDir ? "📁" : "📄"}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  title={entry.name}
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: entry.isDir ? "var(--ui-fg)" : "var(--ui-fg)",
                  }}
                >
                  {entry.name}
                </div>
                <div style={{ color: "var(--ui-muted)", fontSize: 11 }}>
                  {formatSize(entry.size, entry.isDir)} ·{" "}
                  {formatTime(entry.mtime)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 2 }}>
                {!entry.isDir && (
                  <button
                    type="button"
                    style={{ ...buttonStyle, padding: "3px 5px" }}
                    title="下载"
                    onClick={(event) => {
                      event.stopPropagation();
                      download(entry);
                    }}
                  >
                    ↓
                  </button>
                )}
                <button
                  type="button"
                  style={{ ...buttonStyle, padding: "3px 5px" }}
                  title="重命名"
                  onClick={(event) => {
                    event.stopPropagation();
                    rename(entry);
                  }}
                >
                  ✎
                </button>
                <button
                  type="button"
                  style={{
                    ...buttonStyle,
                    padding: "3px 5px",
                    color: "var(--ui-danger)",
                  }}
                  title="删除"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(entry);
                  }}
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      <div
        style={{
          padding: "6px 10px",
          borderTop: "1px solid var(--ui-border)",
          color: "var(--ui-muted)",
          fontSize: 11,
        }}
      >
        拖拽文件到窗口即可上传
      </div>
    </aside>
  );
}
