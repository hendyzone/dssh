import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon, Terminal, init } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";

interface Props {
  sessionId: string;
}

// M1 骨架：ghostty-web 终端组件，经 Tauri commands 与 Rust SSH 层交互
// 注意：固定使用 Canvas 渲染器（WebGL 路径暂不支持 Kitty graphics）
export default function TerminalView({ sessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;

    (async () => {
      await init(wasmUrl);
      if (disposed || !containerRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "Menlo, Consolas, monospace",
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      // 后端输出 → 终端
      const unlisten = await listen<string>(`ssh://${sessionId}/data`, (e) => {
        term?.write(e.payload);
      });
      void unlisten;

      // 终端输入 → 后端
      const dataSub = term.onData((data: string) => {
        invoke("ssh_write", { sessionId, data });
      });

      return () => {
        unlisten();
        dataSub.dispose();
      };
    })();

    return () => {
      disposed = true;
      term?.dispose();
      invoke("ssh_disconnect", { sessionId });
    };
  }, [sessionId]);

  return <div ref={containerRef} className="terminal-view" />;
}
