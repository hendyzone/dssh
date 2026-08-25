import type { ServerEntry } from "../types";

interface Props {
  servers: ServerEntry[];
  onConnect: (s: ServerEntry) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}

// M1：列表 + 新建/删除。M2 加分组与搜索
export default function Sidebar({
  servers,
  onConnect,
  onAdd,
  onDelete,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span>服务器</span>
        <button className="btn-add" onClick={onAdd} title="新建连接">
          ＋
        </button>
      </div>
      {servers.length === 0 ? (
        <div className="sidebar-empty">
          还没有服务器
          <br />
          点右上角 ＋ 新建连接
        </div>
      ) : (
        <ul className="server-list">
          {servers.map((s) => (
            <li key={s.id} className="server-item" onClick={() => onConnect(s)}>
              <div className="server-name">{s.name}</div>
              <div className="server-addr">
                {s.username}@{s.host}:{s.port}
              </div>
              <button
                className="btn-delete"
                title="删除"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
