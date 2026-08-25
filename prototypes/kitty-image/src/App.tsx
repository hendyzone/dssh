import { useEffect, useRef, useState } from 'react';
import { createSession, type SessionHandle } from './terminal';

const SCRIPT_DIR = import.meta.env.VITE_SCRIPT_DIR || '';

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<SessionHandle | null>(null);
  const [status, setStatus] = useState('初始化中…');

  useEffect(() => {
    let disposed = false;
    createSession(containerRef.current as HTMLElement, setStatus).then((s) => {
      if (disposed) {
        s.dispose();
        return;
      }
      sessionRef.current = s;
    });
    return () => {
      disposed = true;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  const showTestImage = () => {
    // 在 shell 中执行测试脚本，输出 Kitty graphics 序列
    sessionRef.current?.sendCommand(
      `bash ${SCRIPT_DIR || '.'}/server/test-image.sh`,
    );
  };

  return (
    <div className="app">
      <header className="toolbar">
        <span className="title">dssh · Kitty 图片协议验证</span>
        <span className={`status ${status === '已连接' ? 'ok' : ''}`}>{status}</span>
        <button onClick={showTestImage}>显示测试图片</button>
        <span className="hint">
          也可以在终端里直接运行 pi，观察图片能否内联显示（看 server 日志里
          [kitty] 的输出判断是否触发了协议探测）
        </span>
      </header>
      <div ref={containerRef} className="terminal-container" />
    </div>
  );
}
