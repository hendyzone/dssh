import { PositionedMenu, MenuItem } from "./ui/positioned-menu";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { History } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState, useRef } from "react";
import type { MouseEvent } from "react";
import { useServerTreeEditing } from "../lib/useServerTreeEditing";
import { buildServerTree, type ServerGroupNode } from "../lib/serverGroups";
import { useSidebarWidth } from "../lib/useSidebarWidth";
import logoUrl from "../assets/logo.png";
import { version } from "../../src-tauri/tauri.conf.json";
import type { ServerEntry } from "../types";
import {
  IconClose,
  IconFolder,
  IconEdit,
  IconPlus,
  IconSearch,
  IconSettings,
} from "./Icons";

interface Props {
  recentIds?: string[];
  servers: ServerEntry[];
  onConnect: (s: ServerEntry) => void;
  onAdd: (group?: string) => void;
  onImport?: () => void;
  onEdit: (s: ServerEntry) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
  onServersChanged?: (servers: ServerEntry[]) => void;
}

const COLLAPSED_KEY = "dssh.sidebar.collapsed-groups";

export default function Sidebar({
  recentIds = [],
  servers,
  onConnect,
  onAdd,
  onImport,
  onEdit,
  onDelete,
  onOpenSettings,
  onServersChanged,
}: Props) {
  const cloneBusy = useRef(false);
  const [grouping, setGrouping] = useState(false);
  const groupingLock = useRef(false);
  const [groupingMessage, setGroupingMessage] = useState("");
  const [recentOpen, setRecentOpen] = useState(true);
  const autoGroup = async () => {
    if (groupingLock.current || !onServersChanged) return;
    groupingLock.current = true;
    setGrouping(true);
    setGroupingMessage("");
    try {
      const records = await invoke<ServerEntry[]>("servers_auto_group");
      onServersChanged(records);
      setGroupingMessage("已按地址归类未分组连接，已有分组保留。");
    } catch {
      setGroupingMessage("自动分组失败，请重试。");
    } finally {
      groupingLock.current = false;
      setGrouping(false);
    }
  };
  const [cloneError, setCloneError] = useState("");
  const cloneServer = async (server: ServerEntry) => {
    if (cloneBusy.current) return;
    cloneBusy.current = true;
    setContextMenu(undefined);
    setCloneError("");
    try {
      const result = await invoke<ServerEntry[]>("servers_clone", {
        id: server.id,
      });
      onServersChanged?.(result);
      setSelectedId(result.at(-1)?.id);
    } catch (reason) {
      setCloneError(String(reason));
    } finally {
      cloneBusy.current = false;
    }
  };
  const editing = useServerTreeEditing(servers, onServersChanged);
  const [folderMenu, setFolderMenu] = useState<{
    path: string;
    x: number;
    y: number;
  } | null>(null);
  const [newFolder, setNewFolder] = useState<{
    parent: string;
    name: string;
  } | null>(null);
  const [folderError, setFolderError] = useState("");
  const createFolder = (parent: string) => {
    setFolderMenu(null);
    setFolderError("");
    setNewFolder({ parent, name: "" });
  };
  const { width, dragging, separatorProps } = useSidebarWidth();
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(COLLAPSED_KEY) ?? "[]",
      );
      return new Set(
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggleFolder = (path: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  useEffect(() => {
    const group = editing.drop?.group;
    if (!group) return;
    const timer = window.setTimeout(
      () =>
        setCollapsed(
          (previous) => new Set([...previous].filter((path) => path !== group)),
        ),
      500,
    );
    return () => window.clearTimeout(timer);
  }, [editing.drop?.group]);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* Keep working without storage. */
    }
  }, [collapsed]);
  const [selectedId, setSelectedId] = useState<string>();
  const [contextMenu, setContextMenu] = useState<{
    server: ServerEntry;
    x: number;
    y: number;
  }>();

  useEffect(() => {
    const closeContextMenu = () => {
      setContextMenu(undefined);
      setFolderMenu(null);
    };
    window.addEventListener("click", closeContextMenu);
    return () => window.removeEventListener("click", closeContextMenu);
  }, []);

  const deleteServer = (server: ServerEntry) => {
    setContextMenu(undefined);
    onDelete(server.id);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return servers;
    return servers.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.host.toLowerCase().includes(q) ||
        s.username.toLowerCase().includes(q) ||
        (s.group ?? "").toLowerCase().includes(q),
    );
  }, [servers, query]);

  const tree = useMemo(
    () =>
      buildServerTree(
        filtered,
        editing.layout.folders.filter(
          (path) =>
            !query.trim() ||
            path.toLowerCase().includes(query.trim().toLowerCase()),
        ),
        editing.layout.order,
      ),
    [filtered, editing.layout, query],
  );
  const renderServer = (s: ServerEntry) => (
    <li
      key={s.id}
      data-tree-server={s.id}
      data-tree-group={
        s.group
          ?.split("/")
          .map((part) => part.trim())
          .filter(Boolean)
          .join("/") ?? ""
      }
      onPointerDown={(event) => editing.startDrag(s.id, event)}
      data-drop={
        editing.drop?.anchor === s.id
          ? editing.drop.after
            ? "after"
            : "before"
          : undefined
      }
      tabIndex={0}
      aria-label={`${s.name}，${s.username}@${s.host}:${s.port}`}
      title={`${s.name} — ${s.username}@${s.host}:${s.port}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          e.stopPropagation();
          onConnect(s);
        }
      }}
      className={`server-item${selectedId === s.id ? " selected" : ""}`}
      onClick={() => {
        setSelectedId(s.id);
        setContextMenu(undefined);
      }}
      onDoubleClick={() => onConnect(s)}
      onContextMenu={(e: MouseEvent<HTMLLIElement>) => {
        e.preventDefault();
        e.stopPropagation();
        setSelectedId(s.id);
        setContextMenu({
          server: s,
          x: e.clientX,
          y: e.clientY,
        });
      }}
    >
      <span className="server-status" />
      <div className="server-item-meta">
        <div className="server-name">{s.name}</div>
        <div className="server-addr">
          {s.username}@{s.host}:{s.port}
        </div>
      </div>
      <div className="server-item-actions">
        <Button
          variant="ghost"
          size="icon-sm"
          className="icon-btn"
          title="编辑"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(s);
          }}
        >
          <IconEdit size={13} />
        </Button>
        <Button
          variant="destructive"
          size="icon-sm"
          className="icon-btn danger"
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            deleteServer(s);
          }}
        >
          <IconClose size={13} />
        </Button>
      </div>
    </li>
  );
  const renderFolder = (node: ServerGroupNode) => {
    const expanded = Boolean(query.trim()) || !collapsed.has(node.path);
    return (
      <li className="server-tree-folder" key={node.path}>
        <div
          className={`server-tree-heading${editing.drop?.group === node.path && !editing.drop.anchor ? " tree-drop-folder" : ""}`}
          data-tree-folder={node.path}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setContextMenu(undefined);
            setFolderMenu({
              path: node.path,
              x: event.clientX,
              y: event.clientY,
            });
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="server-tree-toggle"
            aria-expanded={expanded}
            onClick={() => toggleFolder(node.path)}
            title={node.path}
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            <IconFolder size={14} />
            <span className="server-tree-name">{node.name}</span>
            <span className="server-tree-count">({node.count})</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="icon-btn"
            title={`在「${node.path}」中新建连接`}
            onClick={() => onAdd(node.path)}
          >
            <IconPlus size={13} />
          </Button>
        </div>
        {expanded && (
          <ul className="server-tree-children">
            {node.children.map(renderFolder)}
            {node.servers.map(renderServer)}
          </ul>
        )}
      </li>
    );
  };

  return (
    <aside
      className={`sidebar${dragging ? " sidebar-resizing" : ""}`}
      style={{ width }}
      onClickCapture={(event) => {
        if (editing.suppressClick.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {dragging && <div className="sidebar-resize-overlay" />}
      <div className="sidebar-resize-handle" {...separatorProps} />
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <img src={logoUrl} alt="" />
          <span className="sidebar-brand-label">
            dssh
            <small className="app-version" title={`当前版本 ${version}`}>
              v{version}
            </small>
          </span>
        </div>
        <div className="sidebar-actions">
          <Button
            variant="ghost"
            size="icon-sm"
            className="icon-btn"
            title="新建文件夹"
            onClick={() => createFolder("")}
          >
            <IconFolder size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="icon-btn"
            onClick={onOpenSettings}
            title="设置"
          >
            <IconSettings />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="icon-btn"
            onClick={onImport}
            title="批量导入"
            aria-label="批量导入"
          >
            ⇩
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="icon-btn accent"
            onClick={() => onAdd()}
            title="新建连接"
          >
            <IconPlus />
          </Button>
        </div>
      </div>
      <div className="sidebar-search">
        <IconSearch size={14} />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称 / 地址 / 分组…"
        />
      </div>
      {newFolder && (
        <form
          className="tree-folder-form"
          onSubmit={(event) => {
            event.preventDefault();
            try {
              editing.addFolder(newFolder.parent, newFolder.name);
              setCollapsed(
                (previous) =>
                  new Set(
                    [...previous].filter(
                      (path) =>
                        path !== newFolder.parent &&
                        !newFolder.parent.startsWith(path + "/"),
                    ),
                  ),
              );
              setQuery("");
              setNewFolder(null);
            } catch (error) {
              setFolderError(
                error instanceof Error ? error.message : "保存文件夹失败",
              );
            }
          }}
        >
          <small>
            {newFolder.parent
              ? `在 ${newFolder.parent} 下新建`
              : "新建根文件夹"}
          </small>
          <Input
            autoFocus
            aria-label="文件夹名称"
            value={newFolder.name}
            onChange={(event) =>
              setNewFolder({ ...newFolder, name: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setNewFolder(null);
              }
            }}
            placeholder="文件夹名称"
          />
          {folderError && <small role="alert">{folderError}</small>}
          <div>
            <Button variant="outline" size="sm" type="submit">
              创建
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              onClick={() => setNewFolder(null)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      <div className="sidebar-organize">
        <Button
          variant="outline"
          size="sm"
          disabled={
            grouping ||
            editing.busy ||
            !onServersChanged ||
            !servers.some((s) => !s.group?.trim())
          }
          onClick={autoGroup}
          title="将未分组连接按相同地址归类，保留已有分组"
        >
          {grouping ? "正在分组…" : "自动分组"}
        </Button>
        <small>未分组连接按地址归类</small>
      </div>
      {groupingMessage && (
        <small className="sidebar-organize-message" role="status">
          {groupingMessage}
        </small>
      )}
      {recentIds.some((id) => servers.some((s) => s.id === id)) && (
        <section className="recent-connections" aria-label="最近使用的连接">
          <Button
            variant="ghost"
            size="sm"
            className="recent-heading"
            aria-expanded={recentOpen}
            onClick={() => setRecentOpen((value) => !value)}
          >
            <span aria-hidden="true">{recentOpen ? "▾" : "▸"}</span>
            <History size={14} aria-hidden="true" />
            <span>最近使用</span>
            <small>最多 10 个</small>
          </Button>
          {recentOpen && (
            <div className="recent-list">
              {recentIds
                .slice(0, 10)
                .map((id) => filtered.find((s) => s.id === id))
                .filter((s): s is ServerEntry => !!s)
                .map((s) => (
                  <Button
                    key={s.id}
                    variant="ghost"
                    className="recent-connection"
                    title={`连接 ${s.name} — ${s.username}@${s.host}:${s.port}`}
                    onClick={() => onConnect(s)}
                  >
                    <span>{s.name}</span>
                    <small>
                      {s.username}@{s.host}:{s.port}
                    </small>
                  </Button>
                ))}
            </div>
          )}
        </section>
      )}
      {cloneError && <small role="alert">{cloneError}</small>}
      {editing.error && <small role="alert">{editing.error}</small>}
      {editing.busy && <small role="status">正在保存移动…</small>}
      {editing.dragName && (
        <div className="tree-drag-hint" role="status">
          移动「{editing.dragName}」：拖到文件夹或连接之间，Esc 取消
        </div>
      )}
      <div
        className={`tree-root-drop${editing.drop?.group === "" && !editing.drop.anchor ? " tree-drop-folder" : ""}`}
        data-tree-folder=""
        title="拖到这里移出文件夹"
        onContextMenu={(event) => {
          event.preventDefault();
          setFolderMenu({ path: "", x: event.clientX, y: event.clientY });
        }}
      >
        全部连接 <small>右键文件夹新建子文件夹 · 拖动连接排序</small>
      </div>
      {servers.length === 0 && tree.children.length === 0 ? (
        <div className="sidebar-empty">
          还没有服务器
          <br />
          点右上角 ＋ 新建连接
        </div>
      ) : filtered.length === 0 && tree.children.length === 0 ? (
        <div className="sidebar-empty">没有匹配「{query}」的服务器</div>
      ) : (
        <nav
          className="server-groups server-tree"
          aria-label="服务器分组"
          data-tree-folder=""
        >
          <ul className="server-list">
            {tree.children.map(renderFolder)}
            {tree.servers.map(renderServer)}
          </ul>
        </nav>
      )}
      {folderMenu && (
        <PositionedMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          label="连接操作"
        >
          <MenuItem onClick={() => createFolder(folderMenu.path)}>
            {folderMenu.path ? "新建子文件夹" : "新建文件夹"}
          </MenuItem>
          <MenuItem
            onClick={() => {
              onAdd(folderMenu.path || undefined);
              setFolderMenu(null);
            }}
          >
            新建连接
          </MenuItem>
        </PositionedMenu>
      )}
      {contextMenu && (
        <PositionedMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(undefined)}
          label="连接操作"
        >
          <MenuItem
            onClick={() => {
              onConnect(contextMenu.server);
              setContextMenu(undefined);
            }}
          >
            连接
          </MenuItem>
          <MenuItem
            onClick={() => {
              onEdit(contextMenu.server);
              setContextMenu(undefined);
            }}
          >
            编辑
          </MenuItem>
          <MenuItem onClick={() => void cloneServer(contextMenu.server)}>
            克隆
          </MenuItem>
          <MenuItem
            variant="destructive"
            className="danger"
            onClick={() => deleteServer(contextMenu.server)}
          >
            删除
          </MenuItem>
        </PositionedMenu>
      )}
    </aside>
  );
}
