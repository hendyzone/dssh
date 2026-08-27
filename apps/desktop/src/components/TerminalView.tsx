import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon, Terminal, init } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import { findImageAtPoint } from "../lib/kittyPreview";
import { getTheme } from "../themes";
import type { AppSettings, SessionInfo } from "../types";

interface Props {
  session: SessionInfo;
  active: boolean;
  settings: AppSettings;
  /** 后端 SSH 会话建立/销毁时回调（侧面板、监控需要 backendId） */
  onBackendReady: (paneId: string, backendId: string | null) => void;
}

// ghostty-web 终端组件，经 Tauri commands 与 Rust SSH 层（russh）交互
// 注意：固定使用 Canvas 渲染器（WebGL 路径暂不支持 Kitty graphics）
export default function TerminalView({
  session,
  active,
  settings,
  onBackendReady,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);

  // 标签重新激活时重新 fit（display:none 时尺寸为 0）
  useEffect(() => {
    if (active) fitRef.current?.fit();
  }, [active]);

  // 设置变更热更新（主题/字号/字体）。注意必须逐键赋值：
  // ghostty-web 的 options 是 Proxy，整体替换会绕过 change 处理不触发重绘
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    const theme = getTheme(settings.themeId).term;
    t.options.theme = theme;
    t.options.fontSize = settings.fontSize;
    t.options.fontFamily = settings.fontFamily;
    fitRef.current?.fit();
  }, [settings]);

  useEffect(() => {
    let disposed = false;
    let term: Terminal | null = null;
    let backendId: string | null = null;
    const cleanups: Array<() => void> = [];

    (async () => {
      await init(wasmUrl);
      if (disposed || !containerRef.current) return;

      const theme = getTheme(settings.themeId).term;
      const t = new Terminal({
        cursorBlink: true,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        theme,
      });
      term = t;
      termRef.current = t;
      const fit = new FitAddon();
      fitRef.current = fit;
      t.loadAddon(fit);
      t.open(containerRef.current);
      fit.fit();

      // IME 修复（WebView2/Windows）：ghostty-web 会给容器加 contenteditable，
      // 而 WebView2 对 contentEditable 元素的 IME 组合提交有 bug（吃掉中文输入）。
      // 移除 contenteditable，并把容器上的点击统一引导到隐藏 textarea 获得焦点。
      // 参考: MicrosoftEdge/WebView2Feedback#5625
      {
        const root = containerRef.current;
        root.removeAttribute("contenteditable");
        const textarea = root.querySelector("textarea");
        const focusHandler = (e: MouseEvent) => {
          e.preventDefault();
          textarea?.focus();
        };
        root.addEventListener("mousedown", focusHandler);
        cleanups.push(() =>
          root.removeEventListener("mousedown", focusHandler),
        );
        textarea?.focus();

        // 双击图片 → 单独窗口预览（单击仍留给文本选择）
        const canvas = root.querySelector("canvas");
        if (canvas) {
          const dblHandler = (e: MouseEvent) => {
            const img = findImageAtPoint(t, canvas, e.clientX, e.clientY);
            if (img) {
              invoke("open_image_preview", {
                dataUrl: img.dataUrl,
                width: img.width,
                height: img.height,
              }).catch(() => {});
            }
          };
          canvas.addEventListener("dblclick", dblHandler);
          cleanups.push(() =>
            canvas.removeEventListener("dblclick", dblHandler),
          );
        }
      }

      t.write(
        `\x1b[36m⟫ 正在连接 ${session.server.username}@${session.server.host}:${session.server.port} …\x1b[0m\r\n\r\n`,
      );

      // 先注册输入转发，再连接（连接失败时也能看到终端里的报错）
      const dataSub = t.onData((data: string) => {
        if (backendId) {
          invoke("ssh_write", { sessionId: backendId, data }).catch(() => {});
        }
      });
      cleanups.push(() => dataSub.dispose());
      const resizeSub = t.onResize(
        ({ cols, rows }: { cols: number; rows: number }) => {
          if (backendId) {
            invoke("ssh_resize", { sessionId: backendId, cols, rows }).catch(
              () => {},
            );
          }
        },
      );
      cleanups.push(() => resizeSub.dispose());

      const { server } = session;
      try {
        backendId = await invoke<string>("ssh_connect", {
          params: {
            host: server.host,
            port: server.port,
            username: server.username,
            authMethod: server.authMethod,
            // 密码不在前端持有：后端按 serverId 从 keyring 取；私钥模式传路径
            secret:
              server.authMethod === "publicKey"
                ? (server.keyPath ?? null)
                : null,
            passphrase: null,
            serverId: server.id,
            cols: t.cols,
            rows: t.rows,
          },
        });
      } catch (e) {
        t.write(`\x1b[31m✗ ${String(e)}\x1b[0m\r\n`);
        return;
      }
      if (disposed) {
        invoke("ssh_disconnect", { sessionId: backendId }).catch(() => {});
        return;
      }
      onBackendReady(session.id, backendId);

      cleanups.push(
        await listen<string>(`ssh://${backendId}/data`, (e) => {
          t.write(e.payload);
        }),
      );
      cleanups.push(
        await listen<number>(`ssh://${backendId}/exit`, (e) => {
          const msg =
            e.payload >= 0 ? `进程退出 (exit=${e.payload})` : "连接已断开";
          t.write(`\r\n\x1b[33m⟫ ${msg}\x1b[0m\r\n`);
        }),
      );
    })();

    const onWindowResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      window.removeEventListener("resize", onWindowResize);
      cleanups.forEach((fn) => fn());
      if (backendId) {
        onBackendReady(session.id, null);
        invoke("ssh_disconnect", { sessionId: backendId }).catch(() => {});
      }
      fitRef.current = null;
      termRef.current = null;
      term?.dispose();
    };
    // settings 有独立的热更新 effect，这里只需会话变化时重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  return <div ref={containerRef} className="terminal-view" />;
}
