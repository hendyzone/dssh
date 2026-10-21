import { useEffect } from "react";
import { applyTheme, getTheme } from "../themes";
import TeamOffice from "./TeamOffice";
import { useOfficeSnapshot } from "../lib/officeWindowSync";

/** Dedicated child route: no main App, SSH, roster or polling hooks. */
export default function OfficeWindow() {
  const { snapshot, visible, error } = useOfficeSnapshot();
  useEffect(() => { if (snapshot) applyTheme(getTheme(snapshot.themeId)); }, [snapshot?.themeId]);
  return <main className="office-window">
    {error && <p role="alert">{error}</p>}
    {snapshot ? <TeamOffice snapshot={snapshot} visible={visible}/> : <p role="status">正在等待主窗口的房间快照…</p>}
  </main>;
}
