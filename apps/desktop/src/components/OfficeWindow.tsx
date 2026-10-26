import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyTheme, getTheme } from "../themes";
import TeamOffice from "./TeamOffice";
import { useOfficeSnapshot } from "../lib/officeWindowSync";

/** Dedicated child route: no main App, SSH, roster or polling hooks. */
export default function OfficeWindow() {
  const { snapshot, visible, error } = useOfficeSnapshot();
  const [fullscreen, setFullscreen] = useState(false);
  const change = useRef<((value: boolean) => Promise<void>)>();
  useEffect(() => { if (snapshot) applyTheme(getTheme(snapshot.themeId)); }, [snapshot?.themeId]);
  useEffect(() => {
    const current = getCurrentWindow();
    let disposed = false, revision = 0, changing = false;
    let off: (() => void) | undefined;
    const refresh = async () => {
      if (disposed || changing) return;
      const generation = ++revision;
      try {
        const value = await current.isFullscreen();
        if (!disposed && generation === revision) setFullscreen(value);
      } catch { /* Keep the last confirmed native state. */ }
    };
    change.current = async value => {
      if (changing || disposed) return;
      changing = true;
      ++revision;
      try { await current.setFullscreen(value); }
      finally { changing = false; await refresh(); }
    };
    void (async () => {
      try {
        const unlisten = await current.onResized(() => { void refresh(); });
        if (disposed) { unlisten(); return; }
        off = unlisten;
        await refresh();
      } catch { await refresh(); }
    })();
    return () => { disposed = true; ++revision; change.current = undefined; off?.(); };
  }, []);
  const onFullscreenChange = useCallback(async (value: boolean) => {
    if (!change.current) throw new Error("Window is not ready");
    await change.current(value);
  }, []);
  return <main className="office-window">
    {error && <p role="alert">{error}</p>}
    {snapshot ? <TeamOffice snapshot={snapshot} visible={visible} fullscreen={fullscreen} onFullscreenChange={onFullscreenChange}/> : <p role="status">正在等待主窗口的房间快照…</p>}
  </main>;
}
