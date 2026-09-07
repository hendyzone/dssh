import { AppDialog } from "./ui/app-dialog";
import { Alert } from "./ui/alert";
import { PositionedMenu, MenuItem } from "./ui/positioned-menu";
import {
  X as UiX,
  Pencil as UiPencil,
  Download as UiDownload,
  RefreshCw as UiRefreshCw,
} from "lucide-react";
import { Textarea } from "./ui/textarea";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconClose, IconFolder, IconFile, IconChevronRight } from "./Icons";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { open } from "../platform/dialog";
import { invoke } from "../platform/core";
import { listen } from "../platform/event";
import {
  createTransfer,
  formatTransferSize,
  subscribeTransfers,
  transferPercent,
  waitForTransferListener,
  type Transfer,
} from "../lib/transfers";

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
  serverId?: string;
  /** 当前聚焦窗格的远端终端目录（OSC 7 上报，未知时为 undefined） */
  terminalCwd?: string;
  onClose: () => void;
}

interface DragDropPayload {
  paths: string[];
  position?: { x: number; y: number };
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

export default function SftpPanel({
  sessionId,
  serverId,
  terminalCwd,
  onClose,
}: SftpPanelProps) {
  const [fileMenu, setFileMenu] = useState<{
    entry: FileEntry;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    if (!fileMenu) return;
    const close = () => setFileMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [fileMenu]);
  const panelRef = useRef<HTMLElement>(null);
  const [showHidden, setShowHidden] = useState(
    () => localStorage.getItem("dssh.sftp.hidden") !== "false",
  );
  const [treeMode, setTreeMode] = useState(true);
  const [filter, setFilter] = useState("");
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pathInput, setPathInput] = useState("");
  const [application, setApplication] = useState(
    () => localStorage.getItem("dssh.sftp.application") ?? "",
  );
  const [options, setOptions] = useState(false);
  const [openingCode, setOpeningCode] = useState(false);
  const [editor, setEditor] = useState<{
    path: string;
    original: string;
    content: string;
  } | null>(null);
  const [markdownMode, setMarkdownMode] = useState<"preview" | "edit">(
    "preview",
  );
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent("dssh-file-editor", { detail: !!editor }),
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent("dssh-file-editor", { detail: false }),
      );
    };
  }, [!!editor]);
  const [panePaths, setPanePaths] = useState<
    { id: string; path: string; command: string }[]
  >([]);
  const requestId = useRef(0);
  const [currentPath, setCurrentPath] = useState("/");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [hiddenTransfers, setHiddenTransfers] = useState<Set<string>>(
    new Set(),
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const completed = transfers.filter(
      (t) => t.status === "done" && !hiddenTransfers.has(t.transferId),
    );
    if (!completed.length) return;
    const timer = setTimeout(
      () =>
        setHiddenTransfers(
          (old) =>
            new Set([
              ...old,
              ...completed
                .filter((t) => Date.now() - (t.completedAt ?? 0) >= 5000)
                .map((t) => t.transferId),
            ]),
        ),
      Math.max(
        0,
        Math.min(
          ...completed.map((t) => 5000 - (Date.now() - (t.completedAt ?? 0))),
        ),
      ),
    );
    return () => clearTimeout(timer);
  }, [transfers, hiddenTransfers]);
  const visibleTransfers = transfers.filter(
    (t) => !hiddenTransfers.has(t.transferId),
  );
  /** 跟随模式：终端 cd 时面板自动跳转 */
  const [followTerminal, setFollowTerminal] = useState(false);
  const [loading, setLoading] = useState(false);
  const activeTransfers = transfers.filter(
    (transfer) => transfer.status === "active",
  );

  useEffect(() => {
    if (!sessionId) return;
    return subscribeTransfers(sessionId, setTransfers);
  }, [sessionId]);
  const currentPathRef = useRef(currentPath);

  const loadDirectory = useCallback(
    async (path: string) => {
      if (!sessionId) return; // 会话尚未建立
      const request = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const result = await invoke<FileEntry[]>("sftp_list", {
          sessionId,
          path,
        });
        if (request !== requestId.current) return;
        setChildren({});
        setExpanded(new Set());
        setPathInput(path);
        setEntries(result);
        currentPathRef.current = path;
        setCurrentPath(path);
        setSelectedPath(null);
      } catch (reason) {
        setError(String(reason));
      } finally {
        if (request === requestId.current) setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    if (!sessionId) return;
    void invoke<string>("sftp_home", { sessionId })
      .then((path) => loadDirectory(path))
      .catch(() => loadDirectory("/"));
  }, [loadDirectory, sessionId]);

  // 跟随模式：终端目录变化且与面板当前目录不同时自动跳转
  useEffect(() => {
    if (
      followTerminal &&
      terminalCwd &&
      terminalCwd !== currentPathRef.current
    ) {
      void loadDirectory(terminalCwd);
    }
  }, [followTerminal, terminalCwd, loadDirectory]);

  const uploadFiles = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setError(null);
      setNotice(null);
      try {
        const existing = await invoke<FileEntry[]>("sftp_list", {
          sessionId,
          path: currentPathRef.current,
        });
        const conflicts = paths
          .map(basename)
          .filter((name) => existing.some((entry) => entry.name === name));
        if (
          conflicts.length &&
          !window.confirm("以下文件已存在，覆盖？\n" + conflicts.join("\n"))
        )
          return;
      } catch (reason) {
        setError(String(reason));
        return;
      }
      const queued = paths.map((localPath) => ({
        localPath,
        remotePath: joinRemotePath(currentPathRef.current, basename(localPath)),
        transferId: createTransfer(sessionId, basename(localPath), "upload"),
      }));
      let failed = false;
      try {
        await waitForTransferListener(sessionId);
      } catch (reason) {
        setError(String(reason));
        return;
      }
      for (const transfer of queued) {
        try {
          await invoke("sftp_upload", {
            sessionId,
            remotePath: transfer.remotePath,
            localPath: transfer.localPath,
            transferId: transfer.transferId,
          });
        } catch (reason) {
          failed = true;
          setError(String(reason));
        }
      }
      if (!failed) await loadDirectory(currentPathRef.current);
    },
    [loadDirectory, sessionId],
  );

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const registration = listen<DragDropPayload>(
      "desktop://drag-drop",
      (event) => {
        const rect = panelRef.current?.getBoundingClientRect();
        const point = event.payload.position;
        const ratio = window.devicePixelRatio || 1;
        if (
          !disposed &&
          rect &&
          rect.width > 0 &&
          rect.height > 0 &&
          point &&
          point.x / ratio >= rect.left &&
          point.x / ratio <= rect.right &&
          point.y / ratio >= rect.top &&
          point.y / ratio <= rect.bottom
        )
          void uploadFiles(event.payload.paths ?? []);
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

  const download = (entry: FileEntry, openAfter = false) => {
    const transferId = createTransfer(sessionId, entry.name, "download");
    void (async () => {
      setError(null);
      setNotice(null);
      try {
        await waitForTransferListener(sessionId);
        const localPath = await invoke<string>("sftp_download", {
          sessionId,
          remotePath: entry.path,
          transferId,
        });
        if (openAfter)
          await invoke("sftp_open_local", {
            path: localPath,
            application: application || null,
          });
        setNotice(
          `已下载到 ${localPath}${openAfter ? "，已交给本地应用打开（修改不会自动回传）" : ""}`,
        );
      } catch (reason) {
        setError(String(reason));
      }
    })();
  };

  const cancelTransfer = (transfer: Transfer) => {
    void invoke("cancel_upload", { transferId: transfer.transferId }).catch(
      (reason) => setError(String(reason)),
    );
  };

  const rename = (entry: FileEntry) => {
    const name = window.prompt("新名称", entry.name);
    if (!name?.trim() || name.trim() === entry.name) return;
    void runAction(async () => {
      await invoke("sftp_rename", {
        sessionId,
        oldPath: entry.path,
        newPath: joinRemotePath(
          entry.path.slice(0, entry.path.lastIndexOf("/")) || "/",
          name.trim(),
        ),
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
    else download(entry, true);
  };

  const toggleTree = async (entry: FileEntry) => {
    if (expanded.has(entry.path)) {
      setExpanded(
        (old) => new Set([...old].filter((path) => path !== entry.path)),
      );
      return;
    }
    try {
      const result = await invoke<FileEntry[]>("sftp_list", {
        sessionId,
        path: entry.path,
      });
      setChildren((old) => ({ ...old, [entry.path]: result }));
      setExpanded((old) => new Set([...old, entry.path]));
    } catch (reason) {
      setError(String(reason));
    }
  };
  const editFile = async (entry: FileEntry) => {
    try {
      const text = await invoke<string>("sftp_read_text", {
        sessionId,
        path: entry.path,
      });
      setMarkdownMode("preview");
      setEditor({ path: entry.path, original: text, content: text });
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  };
  const visible: (FileEntry & { depth: number })[] = [];
  const flatten = (items: FileEntry[], depth = 0) => {
    for (const entry of items) {
      if (
        entry.name === "." ||
        entry.name === ".." ||
        (!showHidden && entry.name.startsWith("."))
      )
        continue;
      if (
        !filter ||
        entry.isDir ||
        entry.name.toLowerCase().includes(filter.toLowerCase())
      )
        visible.push({ ...entry, depth });
      if (treeMode && expanded.has(entry.path))
        flatten(children[entry.path] ?? [], depth + 1);
    }
  };
  flatten(entries);
  return (
    <aside ref={panelRef} className="sftp-panel" style={panelStyle}>
      <div
        data-panel-drag-handle
        tabIndex={0}
        title="拖动标题可停靠到左侧或右侧"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 10px 7px",
          borderBottom: "1px solid var(--ui-border)",
        }}
      >
        <strong style={{ color: "var(--ui-fg)", marginRight: "auto" }}>
          SFTP
        </strong>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => terminalCwd && void loadDirectory(terminalCwd)}
          title={
            terminalCwd
              ? `定位到终端目录：${terminalCwd}`
              : "终端目录未知（在终端里执行一条命令后即可识别）"
          }
        >
          ⌖
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => setFollowTerminal((v) => !v)}
          title="跟随终端：终端 cd 时面板自动跳转"
        >
          跟随
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={() => void loadDirectory(currentPath)}
          title="刷新"
        >
          <UiRefreshCw size={14} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={createDirectory}
          title="新建目录"
        >
          ＋目录
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          type="button"
          onClick={onClose}
          title="关闭"
          className="close-icon-btn"
        >
          <IconClose size={14} />
        </Button>
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
              <span style={{ color: "var(--ui-muted)", margin: "0 3px" }}>
                /
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => void loadDirectory(crumb.path)}
              style={{
                border: 0,
                padding: 0,
                background: "transparent",
                color:
                  index === breadcrumbs.length - 1
                    ? "var(--ui-accent)"
                    : "var(--ui-fg)",
                cursor: "pointer",
              }}
            >
              {crumb.label}
            </Button>
          </span>
        ))}
      </div>

      <form
        style={{ display: "flex", gap: 4, padding: "0 10px 7px" }}
        onSubmit={(event) => {
          event.preventDefault();
          if (pathInput.startsWith("/")) void loadDirectory(pathInput);
          else setError("请输入以 / 开头的完整远程路径");
        }}
      >
        <Input
          aria-label="远程路径"
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          style={{ minWidth: 0, flex: 1 }}
        />
        <Button variant="outline" size="sm">
          前往
        </Button>
      </form>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          padding: "0 10px 7px",
        }}
      >
        <Button
          variant="outline"
          size="sm"
          aria-pressed={showHidden}
          onClick={() => {
            setShowHidden(!showHidden);
            localStorage.setItem("dssh.sftp.hidden", String(!showHidden));
          }}
        >
          隐藏文件 {showHidden ? "开" : "关"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={treeMode}
          onClick={() => setTreeMode(!treeMode)}
        >
          {treeMode ? "目录树" : "列表"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const paths = await open({ multiple: true, directory: false });
            if (paths) void uploadFiles(Array.isArray(paths) ? paths : [paths]);
          }}
        >
          上传
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOptions(!options)}
        >
          打开方式
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              const snapshot = await invoke<{
                panes: { id: string; path: string; command: string }[];
              }>("tmux_snapshot", { sessionId });
              setPanePaths(snapshot.panes);
              if (!snapshot.panes.length)
                setNotice("没有 tmux 窗格。可使用上方路径栏或终端目录定位。");
            } catch (reason) {
              setError(String(reason));
            }
          }}
        >
          tmux 工作目录
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!serverId || !currentPath || openingCode}
          title="用 VS Code Remote-SSH 打开当前目录；需要安装 Remote-SSH 扩展，密码由 VS Code 提示输入"
          onClick={async () => {
            setOpeningCode(true);
            setError(null);
            try {
              await invoke("vscode_open", { serverId, path: currentPath });
              setNotice(
                "已启动 VS Code。需要安装 Remote-SSH 扩展；如有登录提示，请在 VS Code 中完成。",
              );
            } catch (reason) {
              setError(String(reason));
            } finally {
              setOpeningCode(false);
            }
          }}
        >
          {openingCode ? "正在打开…" : "VS Code 远程打开"}
        </Button>
      </div>
      {panePaths.length > 0 && (
        <div style={{ padding: 8 }}>
          <small>选择正在运行 Codex / Claude 的窗格</small>
          {panePaths.map((pane) => (
            <Button
              variant="outline"
              size="sm"
              key={pane.id}
              onClick={() => {
                void loadDirectory(pane.path);
                setPanePaths([]);
              }}
            >
              {pane.id} · {pane.command} · {pane.path}
            </Button>
          ))}
        </div>
      )}
      {options && (
        <div style={{ padding: 10 }}>
          <small>
            双击文件：下载后用应用打开；本地修改不会自动回传。远程修改请用“在线编辑”。
          </small>
          <Input
            aria-label="打开文件的应用程序"
            placeholder="留空使用系统默认应用"
            value={application}
            onChange={(event) => {
              setApplication(event.target.value);
              localStorage.setItem("dssh.sftp.application", event.target.value);
            }}
            style={{ width: "100%", boxSizing: "border-box" }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              const path = await open({ multiple: false });
              if (typeof path === "string") {
                setApplication(path);
                localStorage.setItem("dssh.sftp.application", path);
              }
            }}
          >
            选择应用程序
          </Button>
        </div>
      )}
      <Input
        aria-label="筛选文件"
        placeholder="筛选已展开目录中的文件…"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        style={{ margin: "0 10px 8px" }}
      />
      {error && (
        <Alert variant="destructive" className="sftp-feedback">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert role="status" className="sftp-feedback">
          <span>{notice}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="close-icon-btn"
            title="关闭提示"
            onClick={() => setNotice(null)}
          >
            <IconClose size={14} />
          </Button>
        </Alert>
      )}
      {visibleTransfers.length > 0 && (
        <div
          style={{
            margin: "0 8px 6px",
            padding: "7px 8px",
            borderRadius: 4,
            background: "var(--ui-border)",
            color: "var(--ui-fg)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <strong>传输</strong>
            {activeTransfers.length > 0 && (
              <span style={{ color: "var(--ui-accent)", fontSize: 11 }}>
                进行中 {activeTransfers.length}
              </span>
            )}
          </div>
          {visibleTransfers.map((transfer) => {
            const percent = transferPercent(transfer);
            const finished = transfer.status === "done";
            const failed = transfer.status === "error";
            return (
              <div
                key={transfer.transferId}
                style={{
                  marginTop: 8,
                  paddingTop: 7,
                  borderTop: "1px solid var(--ui-panelAlt)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                    fontSize: 12,
                  }}
                >
                  <span
                    title={transfer.fileName}
                    style={{
                      minWidth: 0,
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {transfer.direction === "upload" ? "↑" : "↓"}{" "}
                    {transfer.fileName}
                  </span>
                  {finished && <span aria-label="完成">✓</span>}
                  {failed && (
                    <span
                      title={transfer.error}
                      style={{ color: "var(--ui-danger)" }}
                    >
                      失败
                    </span>
                  )}
                  {!finished && !failed && (
                    <Button
                      variant="destructive"
                      size="sm"
                      type="button"
                      onClick={() => cancelTransfer(transfer)}
                    >
                      取消
                    </Button>
                  )}
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginTop: 5,
                    fontSize: 11,
                    color: failed ? "var(--ui-danger)" : "var(--ui-muted)",
                  }}
                >
                  <div
                    style={{
                      height: 5,
                      flex: 1,
                      overflow: "hidden",
                      borderRadius: 3,
                      background: "var(--ui-panelAlt)",
                    }}
                  >
                    <div
                      style={{
                        width: `${percent}%`,
                        height: "100%",
                        background: failed
                          ? "var(--ui-danger)"
                          : "var(--ui-accent)",
                        transition: "width 120ms linear",
                      }}
                    />
                  </div>
                  <span style={{ width: 34, textAlign: "right" }}>
                    {percent}%
                  </span>
                </div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 11,
                    color: failed ? "var(--ui-danger)" : "var(--ui-muted)",
                  }}
                >
                  <span>
                    {formatTransferSize(transfer.transferredBytes)} /{" "}
                    {formatTransferSize(transfer.totalBytes)}
                    {transfer.error ? ` · ${transfer.error}` : ""}
                  </span>
                  {!finished && !failed && (
                    <span>
                      {formatTransferSize(
                        Math.round(transfer.speedBytesPerSecond),
                      )}
                      /s
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto", padding: "0 5px 8px" }}>
        {loading ? (
          <div style={{ padding: 14, color: "var(--ui-muted)" }}>
            正在读取目录…
          </div>
        ) : visible.length === 0 ? (
          <div style={{ padding: 14, color: "var(--ui-muted)" }}>
            没有可见文件（可调整隐藏文件或筛选）
          </div>
        ) : (
          visible.map((entry) => (
            <div
              key={entry.path}
              className={`sftp-tree-row${selectedPath === entry.path ? " selected" : ""}`}
              title={`${entry.name} · ${formatSize(entry.size, entry.isDir)} · ${formatTime(entry.mtime)}`}
              onClick={() => setSelectedPath(entry.path)}
              onDoubleClick={() => enter(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setFileMenu({ entry, x: event.clientX, y: event.clientY });
                setSelectedPath(entry.path);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minHeight: 30,
                padding: "0 6px",
                marginLeft: entry.depth * 14,
                borderRadius: 4,
                background:
                  selectedPath === entry.path
                    ? "var(--ui-border)"
                    : "transparent",
                cursor: "default",
              }}
            >
              {entry.isDir && treeMode && (
                <button
                  aria-label={
                    (expanded.has(entry.path) ? "折叠 " : "展开 ") + entry.name
                  }
                  className={`tree-chevron${expanded.has(entry.path) ? " expanded" : ""}`}
                  style={{ ...buttonStyle, padding: "1px 3px" }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    void toggleTree(entry);
                  }}
                >
                  <IconChevronRight size={12} />
                </button>
              )}
              {(!entry.isDir || !treeMode) && (
                <span className="tree-chevron-spacer" />
              )}
              <span
                className={`sftp-file-icon${entry.isDir ? " directory" : ""}`}
              >
                {entry.isDir ? (
                  <IconFolder size={15} />
                ) : (
                  <IconFile size={15} />
                )}
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
              </div>
              <div
                className="sftp-row-actions"
                onDoubleClick={(event) => event.stopPropagation()}
                style={{ display: "flex", gap: 2 }}
              >
                {!entry.isDir && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="在线编辑"
                    onClick={(event) => {
                      event.stopPropagation();
                      void editFile(entry);
                    }}
                  >
                    编辑
                  </Button>
                )}
                {!entry.isDir && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    type="button"
                    title="下载"
                    onClick={(event) => {
                      event.stopPropagation();
                      download(entry);
                    }}
                  >
                    <UiDownload size={14} />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  type="button"
                  title="重命名"
                  onClick={(event) => {
                    event.stopPropagation();
                    rename(entry);
                  }}
                >
                  <UiPencil size={14} />
                </Button>
                <Button
                  variant="destructive"
                  size="icon-sm"
                  type="button"
                  title="删除"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(entry);
                  }}
                >
                  <UiX size={14} />
                </Button>
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
        拖文件到此面板上传到当前路径 · 双击文件下载并打开
      </div>
      {fileMenu &&
        createPortal(
          <PositionedMenu
            x={fileMenu.x}
            y={fileMenu.y}
            onClose={() => setFileMenu(null)}
            label="文件操作"
          >
            <MenuItem onClick={() => enter(fileMenu.entry)}>
              {fileMenu.entry.isDir ? "进入目录" : "下载并打开"}
            </MenuItem>
            {!fileMenu.entry.isDir && (
              <>
                <MenuItem onClick={() => void editFile(fileMenu.entry)}>
                  在线编辑
                </MenuItem>
                <MenuItem onClick={() => download(fileMenu.entry)}>
                  下载
                </MenuItem>
              </>
            )}
            <MenuItem
              onClick={() =>
                void navigator.clipboard
                  .writeText(fileMenu.entry.path)
                  .catch(() => setError("无法复制路径"))
              }
            >
              复制远程路径
            </MenuItem>
            <MenuItem onClick={() => rename(fileMenu.entry)}>重命名</MenuItem>
            <MenuItem
              variant="destructive"
              className="danger"
              onClick={() => remove(fileMenu.entry)}
            >
              删除
            </MenuItem>
          </PositionedMenu>,
          document.body,
        )}
      {editor &&
        createPortal(
          <AppDialog
            title="远程文本编辑"
            busy={saving}
            onClose={() => {
              if (
                editor.original === editor.content ||
                window.confirm("放弃未保存的修改？")
              )
                setEditor(null);
            }}
          >
            <div className="remote-editor">
              <strong>
                {editor.path}
                {editor.content !== editor.original ? " · 未保存" : ""}
              </strong>
              <small>UTF-8 文本 · 保存前检查远端变化并创建原文件备份</small>
              {/\.(md|markdown|mdown)$/i.test(editor.path) && (
                <div className="workspace-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={markdownMode === "preview"}
                    onClick={() => setMarkdownMode("preview")}
                  >
                    渲染预览
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={markdownMode === "edit"}
                    onClick={() => setMarkdownMode("edit")}
                  >
                    编辑源码
                  </Button>
                </div>
              )}
              {/\.(md|markdown|mdown)$/i.test(editor.path) &&
              markdownMode === "preview" ? (
                <article className="markdown-preview">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    skipHtml
                    components={{
                      img: ({ alt }) => (
                        <span className="workspace-hint">
                          [图片：{alt || "未加载"}]
                        </span>
                      ),
                      a: ({ children, href }) => (
                        <a href={href} target="_blank" rel="noreferrer">
                          {children}
                        </a>
                      ),
                    }}
                  >
                    {editor.content}
                  </ReactMarkdown>
                </article>
              ) : (
                <Textarea
                  autoFocus
                  aria-label="文件内容"
                  spellCheck={false}
                  value={editor.content}
                  disabled={saving}
                  onChange={(event) =>
                    setEditor({ ...editor, content: event.target.value })
                  }
                  style={{
                    flex: 1,
                    resize: "none",
                    fontFamily: "monospace",
                    background: "var(--ui-panelAlt)",
                    color: "var(--ui-fg)",
                  }}
                />
              )}
              {error && <div role="alert">{error}</div>}
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving || editor.original === editor.content}
                  onClick={async () => {
                    setSaving(true);
                    setError(null);
                    try {
                      const backup = await invoke<string>("sftp_save_text", {
                        sessionId,
                        ...editor,
                      });
                      setEditor({ ...editor, original: editor.content });
                      setNotice("已保存。原文件备份：" + backup);
                    } catch (reason) {
                      setError(String(reason));
                    } finally {
                      setSaving(false);
                    }
                  }}
                >
                  {saving ? "保存中…" : "保存到远程"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => {
                    if (
                      editor.original === editor.content ||
                      window.confirm("放弃未保存的修改？")
                    )
                      setEditor(null);
                  }}
                >
                  关闭
                </Button>
              </div>
            </div>
          </AppDialog>,
          document.body,
        )}
    </aside>
  );
}
