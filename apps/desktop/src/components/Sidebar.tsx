import { useMemo, useState } from "react";
import type { ServerEntry } from "../types";

interface Props {
  servers: ServerEntry[];
  onConnect: (s: ServerEntry) => void;
  onAdd: () => void;
  onEdit: (s: ServerEntry) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}

const UNGROUPED = "未分组";

/** 服务器列表：分组 + 搜索 + 增删改 */
export default function Sidebar({
  servers,
  onConnect,
  onAdd,
  onEdit,
  onDelete,
  onOpenSettings,
}: Props) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

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

  const groups = useMemo(() => {
    const map = new Map<string, ServerEntry[]>();
    for (const s of filtered) {
      const g = s.group?.trim() || UNGROUPED;
      const list = map.get(g) ?? [];
      list.push(s);
      map.set(g, list);
    }
    // 组名排序，未分组排最后
    return [...map.entries()].sort(([a], [b]) =>
      a === UNGROUPED ? 1 : b === UNGROUPED ? -1 : a.localeCompare(b),
    );
  }, [filtered]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>服务器</span>
        <div className="sidebar-actions">
          <button className="btn-add" onClick={onOpenSettings} title="设置">
            ⚙
          </button>
          <button className="btn-add" onClick={onAdd} title="新建连接">
            ＋
          </button>
        </div>
      </div>
      <div className="sidebar-search">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索名称 / 地址 / 分组…"
        />
      </div>
      {servers.length === 0 ? (
        <div className="sidebar-empty">
          还没有服务器
          <br />
          点右上角 ＋ 新建连接
        </div>
      ) : groups.length === 0 ? (
        <div className="sidebar-empty">没有匹配「{query}」的服务器</div>
      ) : (
        <div className="server-groups">
          {groups.map(([group, list]) => (
            <div key={group} className="server-group">
              <div
                className="group-header"
                onClick={() =>
                  setCollapsed((c) => ({ ...c, [group]: !c[group] }))
                }
              >
                <span className="group-arrow">
                  {collapsed[group] ? "▸" : "▾"}
                </span>
                <span>{group}</span>
                <span className="group-count">{list.length}</span>
              </div>
              {!collapsed[group] && (
                <ul className="server-list">
                  {list.map((s) => (
                    <li
                      key={s.id}
                      className="server-item"
                      onClick={() => onConnect(s)}
                    >
                      <div className="server-name">{s.name}</div>
                      <div className="server-addr">
                        {s.username}@{s.host}:{s.port}
                      </div>
                      <div className="server-item-actions">
                        <button
                          className="btn-icon"
                          title="编辑"
                          onClick={(e) => {
                            e.stopPropagation();
                            onEdit(s);
                          }}
                        >
                          ✎
                        </button>
                        <button
                          className="btn-icon danger"
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`删除服务器「${s.name}」？`))
                              onDelete(s.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
