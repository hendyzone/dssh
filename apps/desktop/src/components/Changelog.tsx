import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import ReactMarkdown from "react-markdown";
import { bundledVersion, fallbackNotes, fetchUpdateEntries, type ChangelogEntry } from "../lib/changelog";
import "./Changelog.css";

export function Changelog({ entries }: { entries: ChangelogEntry[] }) {
  return <div className="changelog">
    {entries.map(entry => <section key={entry.version}>
      <h3>v{entry.version}{entry.date && <small>{entry.date}</small>}</h3>
      <ReactMarkdown>{entry.body}</ReactMarkdown>
    </section>)}
  </div>;
}

export function UpdateChangelog({ version, notes }: { version: string; notes: string }) {
  const [remote, setRemote] = useState<{ version: string; entries: ChangelogEntry[] } | null>(null);
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    setRemote(null);
    void (async () => {
      try {
        const current = await getVersion().catch(() => bundledVersion);
        const entries = await fetchUpdateEntries(current, version, controller.signal);
        if (live) setRemote({ version, entries });
      } catch {
        // 远端不可用时保持 latest.json notes，缺 notes 时仅显示版本号。
      } finally { clearTimeout(timeout); }
    })();
    return () => { live = false; clearTimeout(timeout); controller.abort(); };
  }, [version]);
  return <Changelog entries={remote?.version === version ? remote.entries : fallbackNotes(version, notes)}/>;
}
