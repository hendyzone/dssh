import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import logoUrl from "../assets/logo.png";
import type { ServerEntry } from "../types";
import {
  IconClose,
  IconEdit,
  IconPlus,
  IconSearch,
  IconSettings,
} from "./Icons";

interface Props {
  servers: ServerEntry[];
  onConnect: (s: ServerEntry) => void;
  onAdd: () => void;
  onEdit: (s: ServerEntry) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

const ALL_FOLDER = "__all__";
const UNGROUPED = "未分组";
const ACTIVE_FOLDER_KEY = "dssh.sidebar.active-folder";

function getGroup(server: ServerEntry): string {
  return server.group?.trim() || UNGROUPED;
}

function compareGroups(a: string, b: string): number {
  if (a === UNGROUPED) return b === UNGROUPED ? 0 : 1;
  if (b === UNGROUPED) return -1;
  return a.localeCompare(b);
}

function compareServers(a: ServerEntry, b: ServerEntry): number {
  return compareGroups(getGroup(a), getGroup(b)) || a.name.localeCompare(b.name);
}

/** 服务器列表：文件夹 tab + 搜索 + 增删改 */
export default function Sidebar({
  servers,
  onConnect,
  onAdd,
  onEdit,
  onDelete,
  onOpenSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const [activeFolder, setActiveFolder] = useState(() => {
    try {
      return localStorage.getItem(ACTIVE_FOLDER_KEY) ?? ALL_FOLDER;
    } catch {
      return ALL_FOLDER;
    }
  });
  const [selectedId, setSelectedId] = useState<string>();
  const [contextMenu, setContextMenu] = useState<{
    server: ServerEntry;
    x: number;
    y: number;
  }>();

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(undefined);
    window.addEventListener("click", closeContextMenu);
    return () => window.removeEventListener("click", closeContextMenu);
  }, []);

  const deleteServer = (server: ServerEntry) => {
    setContextMenu(undefined);
    if (confirm(`删除服务器「${server.name}」？`)) onDelete(server.id);
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

  const folderTabs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const server of servers) {
      const group = getGroup(server);
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
    const groups = [...counts.keys()].sort(compareGroups);
    return [
      { key: ALL_FOLDER, label: "全部", count: servers.length },
      ...groups.map((group) => ({
        key: group,
        label: group,
        count: counts.get(group) ?? 0,
      })),
    ];
  }, [servers]);

  // 搜索有结果时跨越所有文件夹；未搜索时才按当前 tab 筛选。
  const visibleServers = useMemo(() => {
    const q = query.trim();
    if (q) return filtered.slice().sort(compareServers);
    if (activeFolder === ALL_FOLDER) return servers.slice().sort(compareServers);
    return servers
      .filter((server) => getGroup(server) === activeFolder)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [activeFolder, filtered, query, servers]);

  useEffect(() => {
    if (servers.length > 0 && activeFolder !== ALL_FOLDER &&
        !folderTabs.some((folder) => folder.key === activeFolder)) {
      setActiveFolder(ALL_FOLDER);
      return;
    }
    try {
      localStorage.setItem(ACTIVE_FOLDER_KEY, activeFolder);
    } catch {
      // localStorage 不可用时仍不影响本次使用。
    }
  }, [activeFolder, folderTabs, servers.length]);

  useEffect(() => {
    if (selectedId && !visibleServers.some((server) => server.id === selectedId)) {
      setSelectedId(undefined);
    }
  }, [selectedId, visibleServers]);

  const selectFolder = (folder: string) => {
    setActiveFolder(folder);
    setSelectedId(undefined);
    setContextMenu(undefined);
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <img src={logoUrl} alt="" />
          dssh
        </div>
        <div className="sidebar-actions">
          <button className="icon-btn" onClick={onOpenSettings} title="设置">
            <IconSettings />
          </button>
          <button className="icon-btn accent" onClick={onAdd} title="新建连接">
            <IconPlus />
          </button>
        </div>
      </div>
      <div className="sidebar-search">
        <IconSearch size={14} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称 / 地址 / 分组…"
        />
      </div>
      {servers.length > 0 && (
        <div className="folder-tabs" role="tablist" aria-label="服务器文件夹">
          {folderTabs.map((folder) => (
            <button
              key={folder.key}
              type="button"
              role="tab"
              aria-selected={activeFolder === folder.key}
              className={`folder-tab${activeFolder === folder.key ? " active" : ""}`}
              onClick={() => selectFolder(folder.key)}
              title={`${folder.label}（${folder.count} 个连接）`}
            >
              <span className="folder-tab-label">{folder.label}</span>
              <span className="folder-tab-count">{folder.count}</span>
            </button>
          ))}
        </div>
      )}
      {servers.length === 0 ? (
        <div className="sidebar-empty">
          还没有服务器
          <br />
          点右上角 ＋ 新建连接
        </div>
      ) : visibleServers.length === 0 ? (
        <div className="sidebar-empty">
          {query.trim()
            ? `没有匹配「${query}」的服务器`
            : `「${activeFolder}」暂无服务器`}
        </div>
      ) : (
        <div className="server-groups">
          <ul className="server-list">
            {visibleServers.map((s) => (
              <li
                key={s.id}
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
                  <button
                    className="icon-btn"
                    title="编辑"
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(s);
                    }}
                  >
                    <IconEdit size={13} />
                  </button>
                  <button
                    className="icon-btn danger"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteServer(s);
                    }}
                  >
                    <IconClose size={13} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {contextMenu && (
        <div
          className="sidebar-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
          role="menu"
        >
          <button
            type="button"
            onClick={() => {
              onConnect(contextMenu.server);
              setContextMenu(undefined);
            }}
          >
            连接
          </button>
          <button
            type="button"
            onClick={() => {
              onEdit(contextMenu.server);
              setContextMenu(undefined);
            }}
          >
            编辑
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => deleteServer(contextMenu.server)}
          >
            删除
          </button>
        </div>
      )}
    </aside>
  );
}
