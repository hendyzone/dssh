import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import { AppDialog } from "./ui/app-dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { THEMES, getTheme, themeCategory } from "../themes";
import SyncGuide from "./SyncGuide";
import CollaborationSettings from "./CollaborationSettings";
import type { CollaborationSession } from "../lib/collaboration";
import {
  collectSyncUi,
  restoreSyncUi,
  type SyncRestoreResult,
} from "../lib/syncUi";
import { loadSettings } from "../store";
import type { AppSettings, SyncTestResult, ServerEntry } from "../types";
import { isComposingKey } from "../lib/keyboard";
import { useDialogFocus } from "../lib/useDialogFocus";

interface Props {
  collaborationSessions?: CollaborationSession[];
  servers?: ServerEntry[];
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onClose: () => void;
  /** 同步下载替换 servers.json 后通知外层刷新列表（内存态与磁盘保持一致） */
  onServersChanged?: () => void;
}

const SYNC_REPOSITORY_KEY = "dssh.sync.repository";

function normalizeRepository(value: string): string {
  return value
    .trim()
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
}

type SyncOperation = "sync_test" | "sync_upload" | "sync_download";

/** 设置面板：主题 / 字号 / 字体 / GitHub 加密同步。 */
export default function SettingsModal({
  servers = [],
  collaborationSessions = [],
  settings,
  onChange,
  onClose,
  onServersChanged,
}: Props) {
  const [section, setSection] = useState<"appearance" | "sync" | "collaboration">("appearance");
  const [themeFilter, setThemeFilter] = useState("all");
  const [themeQuery, setThemeQuery] = useState("");
  const visibleThemes = THEMES.filter(
    (t) =>
      (themeFilter === "all" || themeCategory(t) === themeFilter) &&
      `${t.name} ${t.description ?? ""}`
        .toLowerCase()
        .includes(themeQuery.trim().toLowerCase()),
  );
  const [pat, setPat] = useState("");
  const [repository, setRepository] = useState(
    () => localStorage.getItem(SYNC_REPOSITORY_KEY) ?? "",
  );
  const [syncPassword, setSyncPassword] = useState("");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const updateRepository = (value: string) => {
    setRepository(value);
    localStorage.setItem(SYNC_REPOSITORY_KEY, value);
  };

  const runSync = async (operation: SyncOperation) => {
    const normalizedRepository = normalizeRepository(repository);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizedRepository)) {
      setSyncMessage(
        "失败：请填写“所有者/仓库名”，例如 octocat/dssh-config，或粘贴 GitHub 仓库链接",
      );
      return;
    }
    updateRepository(normalizedRepository);
    setSyncBusy(true);
    setSyncMessage(null);
    const credentials = {
      pat: pat || null,
      repository: normalizedRepository,
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
      } else if (operation === "sync_upload") {
        const message = await invoke<string>(operation, {
          ...credentials,
          uiState: collectSyncUi(),
        });
        setSyncMessage(`成功：${message}`);
      } else {
        const result = await invoke<SyncRestoreResult>(operation, credentials);
        try {
          restoreSyncUi(result.uiState);
          onChange(loadSettings());
        } catch {
          setSyncMessage(
            "连接、凭据与私钥已恢复，但界面配置未能保存，请检查本机存储后重试。",
          );
          onServersChanged?.();
          return;
        }
        onServersChanged?.();
        setSyncMessage(`成功：${result.message}`);
      }
    } catch (error) {
      setSyncMessage(`失败：${String(error)}`);
    } finally {
      setSyncBusy(false);
    }
  };

  return (
    <AppDialog title="设置" onClose={onClose} busy={syncBusy}>
      <div
        ref={dialogRef}
        className="modal settings-modal"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isComposingKey(event.nativeEvent)) {
            event.preventDefault();
            event.stopPropagation();
            if (!syncBusy) onClose();
          }
        }}
      >
        <h3 id="settings-title">设置</h3>
        <Tabs
          value={section}
          onValueChange={(value) => setSection(value as "appearance" | "sync" | "collaboration")}
          className="settings-tabs"
        >
          <TabsList className="settings-nav" aria-label="设置分类">
            <TabsTrigger value="appearance">外观</TabsTrigger>
            <TabsTrigger value="sync">同步</TabsTrigger>
            <TabsTrigger value="collaboration">Agent 协作</TabsTrigger>
          </TabsList>
          <div className="settings-scroll">
            <TabsContent value="collaboration"><CollaborationSettings sessions={collaborationSessions}/></TabsContent>
            <TabsContent
              forceMount
              value="appearance"
              className="settings-section"
              hidden={section !== "appearance"}
            >
              <label>主题 · {THEMES.length} 套</label>
              <p className="theme-current">
                当前：{getTheme(settings.themeId).name} · 点击预览即刻应用
              </p>
              <div className="theme-filters" role="group" aria-label="主题分类">
                {[
                  ["all", "全部"],
                  ["dark", "深色"],
                  ["light", "浅色"],
                  ["mixed", "明暗混合"],
                ].map(([value, label]) => (
                  <Button
                    key={value}
                    size="sm"
                    variant="ghost"
                    aria-pressed={themeFilter === value}
                    onClick={() => setThemeFilter(value)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <Input
                className="theme-search"
                aria-label="搜索主题"
                placeholder="搜索主题，例如 One Dark、Monokai…"
                value={themeQuery}
                onChange={(e) => setThemeQuery(e.target.value)}
              />
              <div className="theme-grid">
                {visibleThemes.map((t) => (
                  <button
                    key={t.id}
                    className={`theme-card ${settings.themeId === t.id ? "active" : ""}`}
                    aria-pressed={settings.themeId === t.id}
                    onClick={() => onChange({ ...settings, themeId: t.id })}
                  >
                    <span
                      className="theme-miniature"
                      style={{
                        background: t.term.background,
                        color: t.term.foreground,
                      }}
                      aria-hidden="true"
                    >
                      <span
                        className="theme-mini-sidebar"
                        style={{ background: t.ui.panelAlt, color: t.ui.fg }}
                      >
                        ⌄ 公司
                        <br />
                        　生产
                        <br />
                        　测试
                      </span>
                      <span className="theme-mini-terminal">
                        <span style={{ color: t.term.green ?? t.term.cursor }}>
                          ● SSH · tmux
                        </span>
                        <br />~ ${" "}
                        <span
                          style={{ color: t.term.blue ?? t.term.foreground }}
                        >
                          git status
                        </span>
                        <br />
                        <span style={{ color: t.term.cursor }}>❯</span> _
                      </span>
                      <span
                        className="theme-mini-tools"
                        style={{ background: t.ui.panelAlt, color: t.ui.fg }}
                      >
                        文件
                        <br />
                        tmux
                        <br />
                        监控
                      </span>
                    </span>
                    <span className="theme-swatches">
                      <i style={{ background: t.term.background }} />
                      <i style={{ background: t.term.foreground }} />
                      <i style={{ background: t.ui.accent }} />
                    </span>
                    {t.name}
                    <span className="theme-category-label">
                      {
                        { dark: "深色", light: "浅色", mixed: "明暗混合" }[
                          themeCategory(t)
                        ]
                      }
                      {settings.themeId === t.id ? " · 使用中" : ""}
                    </span>
                    {t.description && <small>{t.description}</small>}
                  </button>
                ))}
              </div>
              {visibleThemes.length === 0 && (
                <p role="status">没有匹配的主题，请换个关键词。</p>
              )}
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
                <Input
                  value={settings.fontFamily}
                  onChange={(e) =>
                    onChange({ ...settings, fontFamily: e.target.value })
                  }
                  placeholder="JetBrains Mono, monospace"
                />
              </label>
            </TabsContent>
            <TabsContent
              forceMount
              value="sync"
              className="settings-section"
              hidden={section !== "sync"}
            >
              <h3>备份与恢复连接</h3>
              <SyncGuide />
              <h4 className="sync-config-title">填写同步配置</h4>
              <label>
                GitHub 访问令牌（PAT）
                <Input
                  type="password"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  placeholder="首次粘贴令牌；本机配置过可留空"
                  disabled={syncBusy}
                  autoComplete="off"
                />
              </label>
              <label>
                仓库地址或名称
                <Input
                  value={repository}
                  onChange={(e) => updateRepository(e.target.value)}
                  placeholder="octocat/dssh-config 或 GitHub 仓库链接"
                  onBlur={() =>
                    updateRepository(normalizeRepository(repository))
                  }
                  disabled={syncBusy}
                  autoComplete="off"
                />
              </label>
              <small className="sync-field-help">
                octocat 是仓库所有者，dssh-config 是仓库名，不是 SSH 连接名称。
              </small>
              <label>
                同步密码
                <Input
                  type="password"
                  value={syncPassword}
                  onChange={(e) => setSyncPassword(e.target.value)}
                  placeholder="首次上传自行设置；下载时使用原来的同步密码"
                  disabled={syncBusy}
                  autoComplete="new-password"
                />
              </label>
              <small className="sync-field-help">
                令牌与同步密码由本机系统凭据库保存；本机以前配置过时可留空沿用，换电脑需重新填写。
              </small>
              <p className="sync-field-help">
                先测试连接：只检查令牌能否访问仓库，不上传或下载；测试成功不代表已有写入权限。
              </p>
              <div className="form-actions" style={{ flexWrap: "wrap" }}>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="btn-secondary"
                  disabled={syncBusy}
                  onClick={() => void runSync("sync_test")}
                >
                  测试连接
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="btn-secondary"
                  disabled={syncBusy}
                  onClick={() => void runSync("sync_upload")}
                >
                  加密上传完整备份
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  className="btn-secondary"
                  disabled={syncBusy}
                  onClick={() => void runSync("sync_download")}
                >
                  从 GitHub 恢复完整备份
                </Button>
              </div>
              <div className="sync-action-notes">
                <p>
                  <strong>上传备份：</strong>
                  用本机连接、凭据、私钥和界面配置的加密备份替换仓库已有的 dssh
                  备份，不改动仓库其他文件。
                </p>
                <p>
                  <strong>下载恢复：</strong>
                  用仓库备份整体替换本机连接列表并恢复凭据、私钥和界面配置，不合并；替换前会保留一份本机列表备份。
                </p>
              </div>
              <details className="sync-troubleshoot">
                <summary>遇到问题？</summary>
                <ul>
                  <li>
                    无法访问仓库：检查名称、令牌有效期、仓库授权和组织审批。
                  </li>
                  <li>
                    测试成功但上传失败：检查 Contents 写入权限或分支保护限制。
                  </li>
                  <li>
                    找不到备份：先在有连接的电脑上传一次；文件名为
                    dssh-sync.json.enc。
                  </li>
                  <li>
                    无法解密：填写上传该备份时的同步密码，更换访问令牌不需要更换同步密码。
                  </li>
                </ul>
              </details>
              {syncBusy && <p role="status">正在处理，请稍候…</p>}
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
            </TabsContent>
          </div>
        </Tabs>
        <div className="form-actions settings-footer">
          <Button
            variant="default"
            size="sm"
            type="button"
            className="btn-primary"
            disabled={syncBusy}
            onClick={onClose}
          >
            完成
          </Button>
        </div>
      </div>
    </AppDialog>
  );
}
