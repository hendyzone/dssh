import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { THEMES } from "../themes";
import type { AppSettings, SyncTestResult } from "../types";

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onClose: () => void;
  /** 同步下载替换 servers.json 后通知外层刷新列表（内存态与磁盘保持一致） */
  onServersChanged?: () => void;
}

const SYNC_REPOSITORY_KEY = "dssh.sync.repository";

type SyncOperation = "sync_test" | "sync_upload" | "sync_download";

/** 设置面板：主题 / 字号 / 字体 / GitHub 加密同步。 */
export default function SettingsModal({ settings, onChange, onClose, onServersChanged }: Props) {
  const [pat, setPat] = useState("");
  const [repository, setRepository] = useState(
    () => localStorage.getItem(SYNC_REPOSITORY_KEY) ?? "",
  );
  const [syncPassword, setSyncPassword] = useState("");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);

  const updateRepository = (value: string) => {
    setRepository(value);
    localStorage.setItem(SYNC_REPOSITORY_KEY, value);
  };

  const runSync = async (operation: SyncOperation) => {
    if (!repository.trim()) {
      setSyncMessage("失败：请填写仓库 owner/name");
      return;
    }
    setSyncBusy(true);
    setSyncMessage(null);
    const credentials = {
      pat: pat || null,
      repository: repository.trim(),
      password: syncPassword || null,
    };
    try {
      if (operation === "sync_test") {
        const result = await invoke<SyncTestResult>(operation, {
          pat: credentials.pat,
          repository: credentials.repository,
        });
        setSyncMessage(
          `连接成功：${result.fullName}（${result.private ? "私有仓库" : "公开仓库"}）`,
        );
      } else {
        const message = await invoke<string>(operation, credentials);
        setSyncMessage(`成功：${message}`);
        if (operation === "sync_download") onServersChanged?.();
      }
    } catch (error) {
      setSyncMessage(`失败：${String(error)}`);
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <label>主题</label>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card ${settings.themeId === t.id ? "active" : ""}`}
              onClick={() => onChange({ ...settings, themeId: t.id })}
            >
              <span className="theme-swatches">
                <i style={{ background: t.term.background }} />
                <i style={{ background: t.term.foreground }} />
                <i style={{ background: t.ui.accent }} />
              </span>
              {t.name}
            </button>
          ))}
        </div>
        <label>
          字号：{settings.fontSize}px
          <input
            type="range"
            min="10"
            max="24"
            value={settings.fontSize}
            onChange={(e) =>
              onChange({ ...settings, fontSize: Number(e.target.value) })
            }
          />
        </label>
        <label>
          字体
          <input
            value={settings.fontFamily}
            onChange={(e) =>
              onChange({ ...settings, fontFamily: e.target.value })
            }
            placeholder="JetBrains Mono, monospace"
          />
        </label>

        <h3>同步</h3>
        <label>
          GitHub PAT
          <input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder="已保存（留空保持不变）"
            autoComplete="off"
          />
        </label>
        <label>
          仓库（owner/name）
          <input
            value={repository}
            onChange={(e) => updateRepository(e.target.value)}
            placeholder="例如：octocat/dssh-config"
            autoComplete="off"
          />
        </label>
        <label>
          同步密码
          <input
            type="password"
            value={syncPassword}
            onChange={(e) => setSyncPassword(e.target.value)}
            placeholder="已保存（留空保持不变）"
            autoComplete="new-password"
          />
        </label>
        <div className="form-actions" style={{ flexWrap: "wrap" }}>
          <button
            type="button"
            className="btn-secondary"
            disabled={syncBusy}
            onClick={() => void runSync("sync_test")}
          >
            测试连接
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={syncBusy}
            onClick={() => void runSync("sync_upload")}
          >
            上传到 GitHub
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={syncBusy}
            onClick={() => void runSync("sync_download")}
          >
            从 GitHub 下载
          </button>
        </div>
        {syncMessage && (
          <div
            role="status"
            style={{
              color: syncMessage.startsWith("失败")
                ? "var(--ui-danger, #f87171)"
                : "var(--ui-accent)",
              fontSize: "12px",
              overflowWrap: "anywhere",
            }}
          >
            {syncMessage}
          </div>
        )}
        <div className="form-actions">
          <button type="button" className="btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
