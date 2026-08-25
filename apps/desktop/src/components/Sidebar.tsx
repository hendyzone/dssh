import type { ServerEntry } from "../types";

interface Props {
  servers: ServerEntry[];
  onConnect: (s: ServerEntry) => void;
}

// M1 骨架：静态列表。M2 实现分组/搜索/编辑。
export default function Sidebar({ servers, onConnect }: Props) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">服务器</div>
      {servers.length === 0 ? (
        <div className="sidebar-empty">还没有服务器</div>
      ) : (
        <ul>
          {servers.map((s) => (
            <li key={s.id} onClick={() => onConnect(s)}>
              {s.name}
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
