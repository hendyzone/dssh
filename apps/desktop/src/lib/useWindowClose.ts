import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";

/** Own the close request end-to-end; never recursively request another close. */
export function useWindowClose(hasActiveSession: boolean): string | null {
  const activeRef = useRef(hasActiveSession);
  activeRef.current = hasActiveSession;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;
    let pending = false;
    let unlisten: (() => void) | undefined;
    appWindow
      .onCloseRequested(async (event) => {
        // Tauri's default continuation also calls destroy(), so prevent it before awaiting.
        event.preventDefault();
        if (disposed || pending) return;
        pending = true;
        setError(null);
        try {
          if (
            activeRef.current &&
            !(await confirm("仍有 SSH 会话连接中，确定要退出 dssh 吗？", {
              title: "退出 dssh",
              kind: "warning",
              okLabel: "退出",
              cancelLabel: "取消",
            }))
          )
            return;
          if (!disposed) await appWindow.destroy();
        } catch (reason) {
          if (!disposed) setError(`关闭窗口失败，请重试：${String(reason)}`);
        } finally {
          pending = false;
        }
      })
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch((reason) => {
        if (!disposed) setError(`注册窗口关闭处理失败：${String(reason)}`);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  return error;
}
