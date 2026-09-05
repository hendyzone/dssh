import { Button } from "./ui/button";
import {
  focusTask,
  ingestTaskOutput,
  reportTask,
  removeTask,
} from "../lib/taskStatus";
import { IconClose } from "./Icons";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon, Terminal, init } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import { findImageAtPoint } from "../lib/kittyPreview";
import { createEchoSuppressor, type EchoSuppressor } from "../lib/echoSuppress";
import { isAppShortcut, isComposingKey } from "../lib/keyboard";
import { OSC7_HOOK } from "../lib/shellIntegration";
import { trackTerminalIme } from "../lib/terminalIme";
import { getTheme } from "../themes";
import type { AppSettings, SessionInfo } from "../types";
import TerminalContextMenu, {
  type TerminalMenuPosition,
} from "./TerminalContextMenu";

type ConnectionState = "connecting" | "connected" | "disconnected";

// 连接成功后注入的 OSC 7 钩子（仅当前会话生效，不写远端任何文件）：
// 每次出现提示符时 shell 上报当前目录，SFTP 面板据此定位/跟随终端目录。
// 覆盖 bash/zsh；前导空格配合
// HISTCONTROL=ignorespace 避免进历史记录。

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
  /** 弹窗、重命名期间暂停终端键盘输入和自动聚焦。 */
  inputEnabled?: boolean;
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
  inputEnabled = true,
  settings,
  onBackendReady,
  onStateChange,
  onCwdChange,
}: Props) {
  const taskName =
    session.server.name + (session.tmux ? " · " + session.tmux.name : "");
  useEffect(() => {
    if (active) focusTask(session.id);
  }, [active, session.id]);
  useEffect(() => () => removeTask(session.id), [session.id]);
  const backendRef = useRef<string | null>(null);
  const clipboardWriteRevision = useRef(0);
  const writeClipboardText = async (text: string) => {
    const revision = ++clipboardWriteRevision.current;
    setClipboardError("正在复制…");
    try {
      await navigator.clipboard.writeText(text);
      if (revision === clipboardWriteRevision.current) {
        setClipboardError("已复制到本机剪贴板，可直接 Ctrl+V 粘贴。");
        setClipboardNoticeVersion((value) => value + 1);
      }
    } catch {
      if (revision === clipboardWriteRevision.current)
        setClipboardError(
          "复制失败，未写入本机剪贴板。请重试选中，或按 Ctrl+Shift+C。",
        );
    }
  };
  const copyBusy = useRef(false);
  const copyText = async (remoteOnly = false) => {
    if (copyBusy.current || !activeRef.current || !inputEnabledRef.current)
      return;
    const target = backendRef.current;
    copyBusy.current = true;
    try {
      let text = remoteOnly ? "" : (termRef.current?.getSelection() ?? "");
      if (!text) {
        if (!target) throw new Error("SSH 连接已断开");
        text = await invoke<string>("tmux_copy_buffer", { sessionId: target });
      }
      if (!text) throw new Error("tmux 复制缓冲区为空");
      if (
        target !== backendRef.current ||
        !activeRef.current ||
        !inputEnabledRef.current
      )
        return;
      await writeClipboardText(text);
    } catch (reason) {
      setClipboardError(String(reason));
    } finally {
      copyBusy.current = false;
    }
  };
  const imageBusy = useRef(false);
  const pasteImage = async (blob?: Blob) => {
    const target = backendRef.current;
    if (
      !target ||
      imageBusy.current ||
      !activeRef.current ||
      !inputEnabledRef.current
    )
      return;
    imageBusy.current = true;
    setClipboardError("正在上传截图…");
    try {
      if (!blob) {
        const items = await navigator.clipboard.read();
        const item = items.find((item) => item.types.includes("image/png"));
        if (!item) throw new Error("剪贴板没有 PNG 截图，请先截图复制。");
        blob = await item.getType("image/png");
      }
      if (blob.size > 20 * 1024 * 1024) throw new Error("截图超过 20 MB");
      const path = await invoke<string>("sftp_clipboard_image", {
        sessionId: target,
        data: Array.from(new Uint8Array(await blob.arrayBuffer())),
      });
      if (
        backendRef.current === target &&
        activeRef.current &&
        inputEnabledRef.current
      ) {
        termRef.current?.paste(JSON.stringify(path) + " ");
        setClipboardError("截图已上传并插入路径，确认后按回车发送。");
      } else
        setClipboardError("截图已上传：" + path + "（焦点已切换，未插入）");
    } catch (reason) {
      setClipboardError(String(reason));
    } finally {
      imageBusy.current = false;
    }
  };
  const pasteClipboard = async () => {
    const terminal = termRef.current;
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const item = items.find((item) => item.types.includes("image/png"));
        if (item) {
          await pasteImage(await item.getType("image/png"));
          return;
        }
      }
      const text = await navigator.clipboard.readText();
      if (
        terminal === termRef.current &&
        activeRef.current &&
        inputEnabledRef.current
      )
        terminal?.paste(text);
    } catch {
      setClipboardError("无法读取剪贴板，请使用 Ctrl+V，或右键选择粘贴截图。");
    }
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const [menu, setMenu] = useState<TerminalMenuPosition | null>(null);
  const [clipboardError, setClipboardError] = useState<string | null>(null);
  const [clipboardNoticeVersion, setClipboardNoticeVersion] = useState(0);
  const clipboardSuccess =
    clipboardError === "截图已上传并插入路径，确认后按回车发送。" ||
    clipboardError === "已复制到本机剪贴板，可直接 Ctrl+V 粘贴。";
  const clipboardPending =
    clipboardError === "正在上传截图…" || clipboardError === "正在复制…";
  useEffect(() => {
    if (!clipboardSuccess) return;
    const timer = window.setTimeout(() => setClipboardError(null), 4000);
    return () => window.clearTimeout(timer);
  }, [clipboardError, clipboardSuccess, clipboardNoticeVersion]);
  const closeMenu = () => {
    setMenu(null);
    // Return focus after the menu's focus scope has unmounted.
    requestAnimationFrame(() => termRef.current?.focus());
  };
  useEffect(() => {
    if (!active || !inputEnabled) setMenu(null);
  }, [active, inputEnabled]);
  const activeRef = useRef(active);
  const inputEnabledRef = useRef(inputEnabled);
  activeRef.current = active;
  inputEnabledRef.current = inputEnabled;
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
      t.options.cursorBlink = active && inputEnabled;
    }
    if (!active || !inputEnabled) {
      const textarea = containerRef.current?.querySelector("textarea");
      if (textarea === document.activeElement) textarea?.blur();
      return;
    }
    // 等显示状态与分屏布局提交后再测量，直接聚焦 textarea 以兼容 WebView2 IME。
    const frame = requestAnimationFrame(() => {
      fitRef.current?.fit();
      termRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, inputEnabled]);

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
    // 注入钩子后抑制其回显：远端 tty/ZLE 会把我们写入的命令回显回来
    //（常夹杂转义序列），在数据流中识别并剔除，超时兜底放行不丢数据。
    let echoSuppressor: EchoSuppressor | null = null;
    let echoFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnect: () => Promise<void> = async () => {};
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    let recovering = false;
    const scheduleRecovery = () => {
      if (!session.tmux || disposed || !recovering || retryCount >= 3) return;
      const delay = 2000 * 2 ** retryCount++;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void reconnect();
      }, delay);
    };
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
        // Own automatic copying so the notice reflects the actual clipboard result.
        copyOnSelect: false,
        cursorBlink: activeRef.current && inputEnabledRef.current,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        theme,
      });
      term = t;
      termRef.current = t;
      const fit = new FitAddon();
      fitRef.current = fit;
      t.loadAddon(fit);
      // ghostty 的默认 focus 会在 open 时聚焦容器并排队再次聚焦。
      // 在 open 前替换本实例的入口，避免后台异步初始化抢焦点。
      t.focus = () => {
        if (!disposed && activeRef.current && inputEnabledRef.current) {
          containerRef.current
            ?.querySelector("textarea")
            ?.focus({ preventScroll: true });
        }
      };
      t.open(containerRef.current);
      cleanups.push(trackTerminalIme(t, containerRef.current));
      {
        const root = containerRef.current;
        let selectionStarted = false;
        const start = (event: MouseEvent) => {
          selectionStarted =
            event.button === 0 &&
            event.target instanceof HTMLCanvasElement &&
            activeRef.current &&
            inputEnabledRef.current &&
            (event.shiftKey || !t.hasMouseTracking());
        };
        const copySelection = () => {
          if (disposed || !activeRef.current || !inputEnabledRef.current)
            return;
          const text = t.getSelection();
          if (text) void writeClipboardText(text);
        };
        // Registered after the terminal's mouseup handler, so selection is finalized.
        const finish = (event: MouseEvent) => {
          const started = selectionStarted;
          selectionStarted = false;
          if (started && event.button === 0 && event.detail < 2)
            copySelection();
        };
        const multiClick = (event: MouseEvent) => {
          if (
            event.button === 0 &&
            event.detail >= 2 &&
            event.target instanceof HTMLCanvasElement &&
            (event.shiftKey || !t.hasMouseTracking())
          )
            copySelection();
        };
        root.addEventListener("mousedown", start, true);
        root.addEventListener("click", multiClick);
        document.addEventListener("mouseup", finish);
        cleanups.push(() => {
          root.removeEventListener("mousedown", start, true);
          root.removeEventListener("click", multiClick);
          document.removeEventListener("mouseup", finish);
          clipboardWriteRevision.current++;
        });
      }
      fit.fit();
      fit.observeResize();

      // IME 修复（WebView2/Windows）：ghostty-web 会给容器加 contenteditable，
      // 而 WebView2 对 contentEditable 元素的 IME 组合提交有 bug（吃掉中文输入）。
      // 移除 contenteditable，并把容器上的点击统一引导到隐藏 textarea 获得焦点。
      // 参考: MicrosoftEdge/WebView2Feedback#5625
      {
        const root = containerRef.current;
        root.removeAttribute("contenteditable");
        const textarea = root.querySelector("textarea");
        const focusHandler = (e: MouseEvent) => {
          if (e.button !== 0 || !inputEnabledRef.current) return;
          e.preventDefault();
          textarea?.focus({ preventScroll: true });
        };
        root.addEventListener("mousedown", focusHandler);
        cleanups.push(() =>
          root.removeEventListener("mousedown", focusHandler),
        );

        // 粘贴/文本输入在 DOM 入口拦截。onData 还承载 DSR 等协议回复，
        // 不能按窗格焦点整体截断，否则后台 shell 可能一直等待回复。
        const guardInput = (event: Event) => {
          if (activeRef.current && inputEnabledRef.current) return;
          event.preventDefault();
          event.stopImmediatePropagation();
        };
        for (const type of ["paste", "beforeinput", "input"]) {
          root.addEventListener(type, guardInput, true);
          cleanups.push(() => root.removeEventListener(type, guardInput, true));
        }

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
        t.focus();
      }

      // 断线时只消费 R/r，其余按键全部拦截，避免写入已经失效的会话。
      t.attachCustomKeyEventHandler((event: KeyboardEvent) => {
        if (!inputEnabledRef.current || !activeRef.current) return true;
        if (isComposingKey(event)) return undefined;
        if (isAppShortcut(event)) return false;
        if (connectionStateRef !== "disconnected") return undefined;
        if (
          event.type === "keydown" &&
          event.key.toLowerCase() === "r" &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.repeat
        ) {
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
      const connect = async (): Promise<void> => {
        if (disposed || connecting) return;
        connecting = true;
        updateState("connecting");

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
              tmux: session.tmux
                ? { id: session.tmux.id, created: session.tmux.created }
                : null,
            },
          });
        } catch (e) {
          connecting = false;
          if (disposed) return;
          backendId = null;
          backendRef.current = null;
          onBackendReady(session.id, null);
          updateState("disconnected");
          t.write(`\x1b[31m✗ ${String(e)}\x1b[0m\r\n`);
          scheduleRecovery();
          return;
        }

        if (disposed) {
          invoke("ssh_disconnect", { sessionId: newBackendId }).catch(() => {});
          return;
        }

        backendId = newBackendId;
        backendRef.current = newBackendId;
        onBackendReady(session.id, newBackendId);

        // 先注册 exit，再注册 data，确保连接刚建立就断开时仍能反馈给 UI。
        try {
          const exitUnlisten = await listen<number>(
            `ssh://${newBackendId}/exit`,
            (e: { payload: number }) => {
              // 旧连接排队中的事件不能影响新连接。
              if (backendId !== newBackendId || disposed) return;
              backendId = null;
              backendRef.current = null;
              detachBackendListeners();
              onBackendReady(session.id, null);
              updateState("disconnected");
              reportTask(
                session.id,
                taskName,
                "disconnected",
                "SSH 终端连接已断开，远程任务可能仍在运行",
              );
              const msg =
                e.payload >= 0 ? `进程退出 (exit=${e.payload})` : "连接已断开";
              t.write(
                `\r\n\x1b[33m⟫ ${msg}\r\n⟫ [已断开] 按 R 或点此重连\x1b[0m\r\n`,
              );
              // 从后端会话表移除已失效句柄，避免重连留下旧连接。
              invoke("ssh_disconnect", { sessionId: newBackendId }).catch(
                () => {},
              );
              if (session.tmux && e.payload < 0) {
                recovering = true;
                scheduleRecovery();
              }
            },
          );
          if (disposed || backendId !== newBackendId) {
            exitUnlisten();
            return;
          }
          backendListeners.push(exitUnlisten);

          let oscCarry = "";
          const handleChunk = (chunk: string) => {
            const scanned = scanOsc7(oscCarry, chunk);
            oscCarry = scanned.carry;
            if (scanned.path)
              onCwdChangeRef.current?.(session.id, scanned.path);
            t.write(chunk);
          };
          const dataUnlisten = await listen<string>(
            `ssh://${newBackendId}/data`,
            (e: { payload: string }) => {
              if (backendId !== newBackendId || disposed) return;
              ingestTaskOutput(session.id, taskName, e.payload);
              let payload = e.payload;
              // 剔除注入钩子的回显（可跨事件截断、可夹杂转义序列）
              if (echoSuppressor) {
                payload = echoSuppressor.process(payload);
                if (!echoSuppressor.active) {
                  echoSuppressor = null;
                  if (echoFlushTimer) {
                    clearTimeout(echoFlushTimer);
                    echoFlushTimer = null;
                  }
                }
              }
              if (payload) handleChunk(payload);
            },
          );
          if (disposed || backendId !== newBackendId) {
            dataUnlisten();
            return;
          }
          backendListeners.push(dataUnlisten);

          await invoke("ssh_start", { sessionId: newBackendId });
          if (disposed || backendId !== newBackendId) return;
          // An attached tmux pane may be running vim, a REPL or a foreground job.
          // Never inject shell initialization into it.
          if (session.tmux) {
            recovering = false;
            retryCount = 0;
            updateState("connected");
            return;
          }

          // 监听准备好后再注入，避免快速回显丢失前缀，导致过滤失效。
          // 使用 shell 实际输出的 OSC 标记结束过滤，不依赖整行回显一致。
          const marker = `dssh-init-${crypto.randomUUID()}`;
          echoSuppressor = createEchoSuppressor(
            "__dssh_osc7",
            `\x1b]1337;${marker}\x07`,
          );
          if (echoFlushTimer) clearTimeout(echoFlushTimer);
          echoFlushTimer = setTimeout(() => {
            echoFlushTimer = null;
            if (echoSuppressor && !disposed) {
              const pending = echoSuppressor.flush();
              echoSuppressor = null;
              if (pending) handleChunk(pending);
            }
          }, 6000);
          const command =
            OSC7_HOOK.slice(0, -1) + `; printf '\\033]1337;${marker}\\007'\r`;
          await invoke("ssh_write", { sessionId: newBackendId, data: command });
          if (!disposed && backendId === newBackendId) updateState("connected");
        } catch (e) {
          detachBackendListeners();
          if (backendId === newBackendId) {
            backendId = null;
            backendRef.current = null;
            onBackendReady(session.id, null);
            updateState("disconnected");
            t.write(`\x1b[31m✗ 初始化终端失败：${String(e)}\x1b[0m\r\n`);
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
        await connect();
      };
      reconnectRef.current = () => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        recovering = false;
        retryCount = 0;
        void reconnect();
      };

      await connect();
    })();

    const onWindowResize = () => fitRef.current?.fit();
    window.addEventListener("resize", onWindowResize);

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectRef.current = null;
      if (echoFlushTimer) {
        clearTimeout(echoFlushTimer);
        echoFlushTimer = null;
      }
      window.removeEventListener("resize", onWindowResize);
      detachBackendListeners();
      cleanups.forEach((fn) => fn());
      if (backendId) {
        onBackendReady(session.id, null);
        invoke("ssh_disconnect", { sessionId: backendId }).catch(() => {});
      }
      backendRef.current = null;
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
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%" }}
        onKeyDownCapture={(event) => {
          if (
            event.key === "Enter" &&
            !event.shiftKey &&
            active &&
            inputEnabled
          )
            reportTask(
              session.id,
              taskName,
              "running",
              "已发送输入，等待终端响应",
              true,
            );
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "c" &&
            active &&
            inputEnabled
          ) {
            event.preventDefault();
            event.stopPropagation();
            void copyText();
            return;
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "v" &&
            active &&
            inputEnabled
          ) {
            event.preventDefault();
            event.stopPropagation();
            void pasteClipboard();
          }
        }}
        onPasteCapture={(event) => {
          const image = [...(event.clipboardData?.items ?? [])]
            .find((item) => item.type === "image/png")
            ?.getAsFile();
          if (image && active && inputEnabled) {
            event.preventDefault();
            event.stopPropagation();
            void pasteImage(image);
          }
        }}
        onContextMenuCapture={(event) => {
          event.preventDefault();
          // Intercept before ghostty's canvas handler attempts a native image menu.
          event.stopPropagation();
          if (!inputEnabled || !termRef.current) return;
          setClipboardError(null);
          setMenu({
            x: event.clientX,
            y: event.clientY,
            selection: termRef.current.getSelection(),
          });
        }}
      />
      {menu && (
        <TerminalContextMenu
          position={menu}
          canPaste={connectionState === "connected" && inputEnabled}
          onCopyTmux={() => {
            closeMenu();
            void copyText(true);
          }}
          onPasteImage={() => {
            closeMenu();
            void pasteImage();
          }}
          onClose={closeMenu}
          onCopy={async () => {
            const text = menu.selection;
            closeMenu();
            if (text) await writeClipboardText(text);
          }}
          onPaste={() => {
            closeMenu();
            void pasteClipboard();
          }}
          onSelectAll={() => {
            termRef.current?.selectAll();
            closeMenu();
          }}
        />
      )}
      {clipboardError && (
        <div
          className={`terminal-clipboard-error${clipboardSuccess ? " is-success" : ""}`}
          role={clipboardSuccess || clipboardPending ? "status" : "alert"}
        >
          <span
            className={`terminal-notice-icon${clipboardPending ? " is-pending" : ""}`}
            aria-hidden="true"
          >
            {clipboardPending ? "" : clipboardSuccess ? "✓" : "!"}
          </span>
          <span className="terminal-notice-text">{clipboardError}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            title="关闭提示"
            aria-label="关闭剪贴板提示"
            onClick={() => setClipboardError(null)}
          >
            <IconClose size={14} />
          </Button>
        </div>
      )}
      {connectionState === "connecting" && (
        <div className="terminal-connection-status" role="status">
          正在连接 {session.server.username}@{session.server.host}:
          {session.server.port}…
        </div>
      )}
      {isDisconnected && (
        <Button
          variant="outline"
          size="sm"
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
        </Button>
      )}
    </div>
  );
}
