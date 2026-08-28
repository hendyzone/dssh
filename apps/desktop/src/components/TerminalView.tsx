import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon, Terminal, init } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import { findImageAtPoint } from "../lib/kittyPreview";
import { getTheme } from "../themes";
import type { AppSettings, SessionInfo } from "../types";

type ConnectionState = "connecting" | "connected" | "disconnected";

// 连接成功后注入的 OSC 7 钩子（仅当前会话生效，不写远端任何文件）：
// 每次出现提示符时 shell 上报当前目录，SFTP 面板据此定位/跟随终端目录。
// 覆盖 bash/zsh；其余 shell 会静默忽略或设一个无害变量。前导空格配合
// HISTCONTROL=ignorespace 避免进历史记录。
const OSC7_HOOK =
  ' __dssh_osc7(){ printf "\\033]7;file://%s%s\\033\\\\" "${HOSTNAME:-$(hostname)}" "$PWD"; };case "$0" in *zsh*) precmd_functions+=(__dssh_osc7);; *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;};__dssh_osc7";;esac\r';

const OSC7_RE =
  /\x1b\]7;file:\/\/[^\x07\x1b]*?(\/[^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

/**
 * 从输出流中解析 OSC 7 路径。序列可能跨事件被截断，
 * 用 carry 保留末尾不完整的片段与下一块拼接。
 */
function scanOsc7(
  carry: string,
  chunk: string,
): { path: string | null; carry: string } {
  const text = carry + chunk;
  let path: string | null = null;
  let lastEnd = 0;
  OSC7_RE.lastIndex = 0;
  for (let m = OSC7_RE.exec(text); m; m = OSC7_RE.exec(text)) {
    try {
      path = decodeURIComponent(m[1]);
    } catch {
      path = m[1];
    }
    lastEnd = m.index + m[0].length;
  }
  const tailStart = text.lastIndexOf("\x1b]7;");
  const nextCarry =
    tailStart >= lastEnd ? text.slice(tailStart, tailStart + 512) : "";
  return { path, carry: nextCarry };
}

interface Props {
  session: SessionInfo;
  active: boolean;
  settings: AppSettings;
  /** 后端 SSH 会话建立/销毁时回调（侧面板、监控需要 backendId） */
  onBackendReady: (paneId: string, backendId: string | null) => void;
  /** SSH 连接状态变化回调（供标签状态点等外部 UI 使用） */
  onStateChange?: (paneId: string, state: ConnectionState) => void;
  /** 远端 shell 当前目录变化回调（OSC 7，供 SFTP 定位/跟随使用） */
  onCwdChange?: (paneId: string, cwd: string) => void;
}

// ghostty-web 终端组件，经 Tauri commands 与 Rust SSH 层（russh）交互
// 注意：固定使用 Canvas 渲染器（WebGL 路径暂不支持 Kitty graphics）
export default function TerminalView({
  session,
  active,
  settings,
  onBackendReady,
  onStateChange,
  onCwdChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onStateChangeRef = useRef(onStateChange);
  const onCwdChangeRef = useRef(onCwdChange);
  const reconnectRef = useRef<(() => void) | null>(null);
  const [connectionState, setConnectionState] =
    useState<ConnectionState>("connecting");

  useEffect(() => {
    onStateChangeRef.current = onStateChange;
    onCwdChangeRef.current = onCwdChange;
  }, [onStateChange, onCwdChange]);

  // 标签重新激活时重新 fit（display:none 时尺寸为 0）
  useEffect(() => {
    const t = termRef.current;
    if (t) {
      // 非聚焦窗格的光标不闪烁，避免分屏时多个光标一起闪
      t.options.cursorBlink = active;
    }
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
    // session 变化时，先把外部状态点恢复为连接中。
    setConnectionState("connecting");
    onStateChangeRef.current?.(session.id, "connecting");
    let connecting = false;
    let connectionStateRef: ConnectionState = "connecting";
    let reconnect: () => Promise<void> = async () => {};
    const cleanups: Array<() => void> = [];
    const backendListeners: UnlistenFn[] = [];

    const updateState = (next: ConnectionState) => {
      if (connectionStateRef === next) return;
      connectionStateRef = next;
      setConnectionState(next);
      onStateChangeRef.current?.(session.id, next);
    };

    const detachBackendListeners = () => {
      backendListeners.splice(0).forEach((unlisten) => unlisten());
    };

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
        textarea?.focus();
      }

      t.write(
        `\x1b[36m⟫ 正在连接 ${session.server.username}@${session.server.host}:${session.server.port} …\x1b[0m\r\n\r\n`,
      );

      // 断线时只消费 R/r，其余按键全部拦截，避免写入已经失效的会话。
      t.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (connectionStateRef !== "disconnected") return undefined;
        if (event.type === "keydown" && event.key.toLowerCase() === "r") {
          event.preventDefault();
          reconnectRef.current?.();
        }
        return true;
      });

      // 输入和 resize 回调始终复用这个 Terminal；连接断开时 backendId 会被清空。
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
      const connect = async (isReconnect: boolean): Promise<void> => {
        if (disposed || connecting) return;
        connecting = true;
        updateState("connecting");
        if (isReconnect) {
          t.write("\r\n\x1b[36m⟫ 正在重新连接 …\x1b[0m\r\n");
        }

        let newBackendId: string;
        try {
          newBackendId = await invoke<string>("ssh_connect", {
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
          connecting = false;
          if (disposed) return;
          backendId = null;
          onBackendReady(session.id, null);
          updateState("disconnected");
          t.write(`\x1b[31m✗ ${String(e)}\x1b[0m\r\n`);
          return;
        }

        if (disposed) {
          invoke("ssh_disconnect", { sessionId: newBackendId }).catch(() => {});
          return;
        }

        backendId = newBackendId;
        onBackendReady(session.id, newBackendId);
        updateState("connected");
        // 注入 OSC 7 目录上报钩子（回显一行属正常，钩子本身无输出）
        invoke("ssh_write", { sessionId: newBackendId, data: OSC7_HOOK }).catch(
          () => {},
        );
        if (isReconnect) {
          t.write("\x1b[32m⟫ 已重新连接\x1b[0m\r\n");
        }

        // 先注册 exit，再注册 data，确保连接刚建立就断开时仍能反馈给 UI。
        try {
          const exitUnlisten = await listen<number>(
            `ssh://${newBackendId}/exit`,
            (e: { payload: number }) => {
              // 旧连接排队中的事件不能影响新连接。
              if (backendId !== newBackendId || disposed) return;
              backendId = null;
              detachBackendListeners();
              onBackendReady(session.id, null);
              updateState("disconnected");
              const msg =
                e.payload >= 0 ? `进程退出 (exit=${e.payload})` : "连接已断开";
              t.write(
                `\r\n\x1b[33m⟫ ${msg}\r\n⟫ [已断开] 按 R 或点此重连\x1b[0m\r\n`,
              );
              // 从后端会话表移除已失效句柄，避免重连留下旧连接。
              invoke("ssh_disconnect", { sessionId: newBackendId }).catch(
                () => {},
              );
            },
          );
          if (disposed || backendId !== newBackendId) {
            exitUnlisten();
            return;
          }
          backendListeners.push(exitUnlisten);

          let oscCarry = "";
          const dataUnlisten = await listen<string>(
            `ssh://${newBackendId}/data`,
            (e: { payload: string }) => {
              if (backendId !== newBackendId || disposed) return;
              const scanned = scanOsc7(oscCarry, e.payload);
              oscCarry = scanned.carry;
              if (scanned.path)
                onCwdChangeRef.current?.(session.id, scanned.path);
              t.write(e.payload);
            },
          );
          if (disposed || backendId !== newBackendId) {
            dataUnlisten();
            return;
          }
          backendListeners.push(dataUnlisten);
        } catch (e) {
          detachBackendListeners();
          if (backendId === newBackendId) {
            backendId = null;
            onBackendReady(session.id, null);
            updateState("disconnected");
            t.write(`\x1b[31m✗ 监听连接事件失败：${String(e)}\x1b[0m\r\n`);
            invoke("ssh_disconnect", { sessionId: newBackendId }).catch(
              () => {},
            );
          }
        } finally {
          connecting = false;
        }
      };

      reconnect = async () => {
        if (connectionStateRef !== "disconnected") return;
        await connect(true);
      };
      reconnectRef.current = () => {
        void reconnect();
      };

      await connect(false);
    })();

    const onWindowResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      reconnectRef.current = null;
      window.removeEventListener("resize", onWindowResize);
      detachBackendListeners();
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

  const isDisconnected = connectionState === "disconnected";
  return (
    <div className="terminal-view" style={{ position: "relative" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      {isDisconnected && (
        <button
          type="button"
          onClick={() => reconnectRef.current?.()}
          style={{
            position: "absolute",
            left: "50%",
            bottom: "18px",
            transform: "translateX(-50%)",
            zIndex: 2,
            padding: "7px 16px",
            border: "1px solid #d8a31a",
            borderRadius: "4px",
            background: "rgba(45, 35, 10, 0.95)",
            color: "#ffd866",
            font: "inherit",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          [已断开] 点此重连
        </button>
      )}
    </div>
  );
}
