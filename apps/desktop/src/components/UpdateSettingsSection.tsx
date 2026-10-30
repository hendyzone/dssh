import { Changelog } from "./Changelog";
import { bundledVersion, installedEntries } from "../lib/changelog";
import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "./ui/button";
import { invoke } from "@tauri-apps/api/core";
import { RELEASE_PAGE } from "../lib/appUpdater";
import { manualUpdateCheck } from "../lib/appUpdaterTauri";

interface Props {
  onUpdateFound: (offer: import("../lib/appUpdater").UpdateOffer, linkOnly: boolean) => void;
}

export default function UpdateSettingsSection({ onUpdateFound }: Props) {
  const [version, setVersion] = useState(bundledVersion);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => setVersion(bundledVersion));
  }, []);

  const check = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const offer = await manualUpdateCheck();
      if (!offer) {
        setMessage("当前已是最新版本");
        return;
      }
      const mode = await invoke<"auto_install" | "link_only">("updater_install_mode");
      onUpdateFound(offer, mode === "link_only");
      setMessage(`发现 ${offer.version}，请在弹窗中确认`);
    } catch (error) {
      setMessage(`检查失败：${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-section">
      <p>
        当前版本：<strong>{version}</strong>
      </p>
      <p className="sync-field-help">
        更新源：GitHub Releases（latest.json）。deb/rpm 安装包仅提示下载链接，不自动覆盖系统包管理器。
      </p>
      <Button type="button" disabled={busy} onClick={() => void check()}>
        检查更新
      </Button>
      {message ? <p role="status">{message}</p> : null}
      <details className="changelog-history">
        <summary>更新日志</summary>
        <Changelog entries={installedEntries(version)}/>
      </details>
      <p className="sync-field-help">
        <a href={RELEASE_PAGE} target="_blank" rel="noreferrer">
          打开 GitHub 发布页
        </a>
      </p>
    </div>
  );
}
