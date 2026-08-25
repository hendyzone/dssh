// ghostty-web 终端封装：初始化 WASM、连接 ws 桥、双向绑定数据流
import { FitAddon, Terminal, init } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";

// 测试钩子：记录所有发送到 pty 的输入（自动化 IME 测试断言用）
declare global {
  interface Window {
    __sent: string[];
  }
}
window.__sent = [];

export interface SessionHandle {
  term: Terminal;
  sendCommand: (cmd: string) => void;
  dispose: () => void;
}

export async function createSession(
  container: HTMLElement,
  onStatus: (s: string) => void,
): Promise<SessionHandle> {
  await init(wasmUrl);

  const term = new Terminal({
    cols: 120,
    rows: 32,
    cursorBlink: true,
    fontSize: 14,
    fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
    theme: {
      background: "#1a1b26",
      foreground: "#a9b1d6",
    },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  // IME 修复（WebView2/Windows）：移除 contenteditable（WebView2 对其 IME 有 bug），
  // 点击容器统一聚焦到隐藏 textarea。与 apps/desktop TerminalView 保持一致。
  container.removeAttribute("contenteditable");
  const textarea = container.querySelector("textarea");
  container.addEventListener("mousedown", (e) => {
    e.preventDefault();
    textarea?.focus();
  });
  textarea?.focus();

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    onStatus("已连接");
    ws.send(
      JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
    );
  };
  ws.onclose = () => onStatus("已断开");
  ws.onerror = () => onStatus("连接错误");
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "data") term.write(msg.data);
    } catch {
      // 忽略非 JSON 帧
    }
  };

  const dataSub = term.onData((data: string) => {
    window.__sent.push(data);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data }));
    }
  });

  const onResize = () => {
    fit.fit();
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
      );
    }
  };
  window.addEventListener("resize", onResize);

  return {
    term,
    sendCommand: (cmd) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data: `${cmd}\n` }));
      }
    },
    dispose: () => {
      window.removeEventListener("resize", onResize);
      dataSub.dispose();
      ws.close();
      term.dispose();
    },
  };
}
