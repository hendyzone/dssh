import { useState } from "react";
import ServerForm from "./components/ServerForm";
import Sidebar from "./components/Sidebar";
import TerminalView from "./components/TerminalView";
import { loadServers, saveServers } from "./store";
import type { ServerEntry, SessionInfo } from "./types";

export default function App() {
  const [servers, setServers] = useState<ServerEntry[]>(loadServers);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const connect = (server: ServerEntry) => {
    // 同一台服务器复用已有标签
    const existing = sessions.find((s) => s.server.id === server.id);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    const session: SessionInfo = { id: crypto.randomUUID(), server };
    setSessions((prev) => [...prev, session]);
    setActiveId(session.id);
  };

  const closeSession = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  const addServer = (s: ServerEntry) => {
    const next = [...servers, s];
    setServers(next);
    saveServers(next);
    setShowForm(false);
    connect(s);
  };

  const deleteServer = (id: string) => {
    const next = servers.filter((s) => s.id !== id);
    setServers(next);
    saveServers(next);
    // 顺带关掉该服务器的会话
    sessions
      .filter((s) => s.server.id === id)
      .forEach((s) => closeSession(s.id));
  };

  return (
    <div className="app">
      <Sidebar
        servers={servers}
        onConnect={connect}
        onAdd={() => setShowForm(true)}
        onDelete={deleteServer}
      />
      <main className="main-area">
        {sessions.length > 0 && (
          <div className="tab-bar">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`tab ${s.id === activeId ? "active" : ""}`}
                onClick={() => setActiveId(s.id)}
              >
                <span>{s.server.name}</span>
                <button
                  className="tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeSession(s.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {sessions.length === 0 ? (
          <div className="empty-state">
            <h2>dssh</h2>
            <p>点左侧 ＋ 新建一台服务器开始</p>
          </div>
        ) : (
          // 非活跃标签保持挂载（display:none），会话状态不丢失
          sessions.map((s) => (
            <div
              key={s.id}
              className="terminal-wrapper"
              hidden={s.id !== activeId}
            >
              <TerminalView session={s} active={s.id === activeId} />
            </div>
          ))
        )}
      </main>
      {showForm && (
        <ServerForm onSubmit={addServer} onCancel={() => setShowForm(false)} />
      )}
    </div>
  );
}
