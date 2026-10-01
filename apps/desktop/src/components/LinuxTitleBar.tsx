import { getCurrentWindow } from "@tauri-apps/api/window";
import { useState } from "react";

export const linuxTitleBar = /Linux/i.test(navigator.platform) && "__TAURI_INTERNALS__" in window;

export default function LinuxTitleBar() {
  const [error, setError] = useState("");
  if (!linuxTitleBar) return null;
  const run = (action: () => Promise<void>) => { void action().catch(e => setError(String(e))); };
  return <header className="linux-titlebar">
    <div className="linux-titlebar-drag" data-tauri-drag-region>dssh</div>
    {error && <span role="alert">{error}</span>}
    <button aria-label="最小化窗口" onClick={() => run(() => getCurrentWindow().minimize())}>—</button>
    <button aria-label="最大化或还原窗口" onClick={() => run(() => getCurrentWindow().toggleMaximize())}>□</button>
    <button className="window-close" aria-label="关闭窗口" onClick={() => run(() => getCurrentWindow().close())}>×</button>
  </header>;
}
