import { invoke } from "@tauri-apps/api/core";

export type TerminalDownloadNotice =
  | {phase: "progress"; name: string; percent: number; detail: string}
  | {phase: "done"; name: string; localPath: string}
  | {phase: "error"; name: string; detail: string};

/** Result of a terminal-triggered download; same wording as the SFTP panel notice. */
export default function TerminalDownloadNotice({notice, onClose}: {notice: TerminalDownloadNotice; onClose: () => void}) {
  return <div className={`terminal-clipboard-error terminal-download-notice${notice.phase === "error" ? "" : " is-success"}`}
    role={notice.phase === "error" ? "alert" : "status"}>
    <span className={`terminal-notice-icon${notice.phase === "progress" ? " is-pending" : ""}`} aria-hidden="true">
      {notice.phase === "progress" ? "…" : notice.phase === "done" ? "✓" : "!"}
    </span>
    <span className="terminal-notice-text">
      {notice.phase === "progress" && `正在下载 ${notice.name} ${notice.percent}%`}
      {notice.phase === "progress" && notice.detail && ` · ${notice.detail}`}
      {notice.phase === "done" && `已下载到 ${notice.localPath}`}
      {notice.phase === "error" && `下载失败：${notice.detail}`}
    </span>
    {notice.phase === "done" && (
      <button type="button" onClick={() => { void invoke("sftp_reveal_local", {path: notice.localPath}).catch(() => {}); }}>打开所在目录</button>
    )}
    <button type="button" aria-label="关闭下载提示" onClick={onClose}>×</button>
  </div>;
}
