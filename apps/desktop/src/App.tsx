import { useState } from "react";
import Sidebar from "./components/Sidebar";
import TerminalView from "./components/TerminalView";
import type { ServerEntry } from "./types";

// M1 骨架：侧边栏 + 终端区布局。服务器数据后续存本地（tauri store）或配置文件
export default function App() {
  const [servers] = useState<ServerEntry[]>([]);
  const [activeSession, setActiveSession] = useState<string | null>(null);

  return (
    <div className="app">
      <Sidebar servers={servers} onConnect={(s) => setActiveSession(s.id)} />
      <main className="main-area">
        {activeSession ? (
          <TerminalView key={activeSession} sessionId={activeSession} />
        ) : (
          <div className="empty-state">
            <h2>dssh</h2>
            <p>从左侧选择一台服务器开始</p>
          </div>
        )}
      </main>
    </div>
  );
}
