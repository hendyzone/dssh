import { useState } from "react";
import { X as UiX, FolderDown } from "lucide-react";
import { Button } from "./ui/button";
import { AppDialog } from "./ui/app-dialog";
import {
  dismissTransfer,
  formatTransferSize,
  transferPercent,
  type Transfer,
} from "../lib/transfers";

export type ConflictPolicy = "overwrite" | "skip" | "rename";

export interface LocalConflict {
  name: string;
  isDir: boolean;
  renameTo: string;
}

/** 文件夹下载在传输面板里的一项：统计中 / 进行中 / 取消 / 完成（含失败明细）。 */
export function TreeTransferItem({
  transfer,
  onCancel,
}: {
  transfer: Transfer;
  onCancel: (transfer: Transfer) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const tree = transfer.tree!;
  const active = transfer.status === "active";
  const scanning = active && tree.phase === "scanning";
  const canceled = transfer.status === "canceled";
  const fatal = transfer.status === "error";
  const issues = tree.failureCount + tree.skippedCount;
  const percent = transferPercent(transfer);
  const files = `${tree.completedFiles}/${tree.totalFiles} 个文件`;
  let summary: string;
  if (scanning) summary = `正在统计… 已发现 ${tree.discoveredFiles} 个文件`;
  else if (active) summary = `${files} · ${formatTransferSize(transfer.transferredBytes)} / ${formatTransferSize(transfer.totalBytes)}`;
  else if (canceled) summary = `已取消（${tree.completedFiles}/${tree.totalFiles} 个文件已完成）`;
  else if (fatal) summary = `失败：${transfer.error ?? "未知错误"}`;
  else
    summary =
      `完成：${tree.downloadedFiles} 个文件已下载` +
      (tree.skippedExisting ? `，${tree.skippedExisting} 个已存在跳过` : "") +
      (tree.failureCount ? `，${tree.failureCount} 个失败` : "");
  const tone = fatal || tree.failureCount ? "danger" : canceled ? "warn" : "muted";
  return (
    <div
      className="sftp-transfer sftp-tree-transfer"
      data-status={transfer.status}
      aria-label={`文件夹下载：${transfer.fileName}`}
    >
      <div className="sftp-transfer-head">
        <span className="sftp-transfer-name" title={tree.localRoots.join("\n") || transfer.fileName}>
          <FolderDown size={13} aria-hidden /> {transfer.fileName}
        </span>
        {transfer.status === "done" && !tree.failureCount && <span aria-label="完成">✓</span>}
        {active ? (
          <Button variant="destructive" size="sm" type="button" onClick={() => onCancel(transfer)}>
            取消
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            aria-label={"关闭传输提示：" + transfer.fileName}
            title="关闭传输提示"
            onClick={() => dismissTransfer(transfer.transferId)}
          >
            <UiX size={14} />
          </Button>
        )}
      </div>
      <div className="sftp-transfer-bar-row">
        <div
          className={`sftp-transfer-bar${scanning ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label="下载进度"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={scanning ? undefined : percent}
        >
          <div style={{ width: scanning ? "30%" : `${percent}%` }} data-tone={tone} />
        </div>
        <span className="sftp-transfer-percent">{scanning ? "…" : `${percent}%`}</span>
      </div>
      <div className="sftp-transfer-meta" data-tone={tone}>
        <span>{summary}</span>
        {active && !scanning && (
          <span>{formatTransferSize(Math.round(transfer.speedBytesPerSecond))}/s</span>
        )}
      </div>
      {active && !scanning && tree.currentFile && (
        <div className="sftp-transfer-current" title={tree.currentFile}>
          {tree.currentFile}
        </div>
      )}
      {!active && issues > 0 && (
        <>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className="sftp-transfer-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {(expanded ? "收起 " : "查看 ") +
              [
                tree.failureCount ? `${tree.failureCount} 个失败` : "",
                tree.skippedCount ? `${tree.skippedCount} 个跳过的链接/特殊文件` : "",
              ]
                .filter(Boolean)
                .join("、")}
          </Button>
          {expanded && (
            <ul className="sftp-transfer-issues" aria-label="失败与跳过明细">
              {tree.failures.map((issue) => (
                <li key={"f" + issue.path} data-kind="failure" title={issue.path}>
                  <span>{issue.path}</span>
                  <small>{issue.reason}</small>
                </li>
              ))}
              {tree.skipped.map((issue) => (
                <li key={"s" + issue.path} data-kind="skipped" title={issue.path}>
                  <span>{issue.path}</span>
                  <small>{issue.reason}</small>
                </li>
              ))}
              {tree.failures.length + tree.skipped.length < issues && (
                <li data-kind="more">另有 {issues - tree.failures.length - tree.skipped.length} 项未列出</li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/** 本地已存在同名项时一次性选择处理方式，作用于整批。 */
export function FolderConflictDialog({
  localDir,
  conflicts,
  onResolve,
}: {
  localDir: string;
  conflicts: LocalConflict[];
  onResolve: (policy: ConflictPolicy | null) => void;
}) {
  const [policy, setPolicy] = useState<ConflictPolicy>("rename");
  const shown = conflicts.slice(0, 6);
  const renamed = conflicts.length === 1 ? `“${conflicts[0].renameTo}”` : "“名称 (1)”";
  const options: { value: ConflictPolicy; label: string; hint: string }[] = [
    { value: "rename", label: `另存为 ${renamed}`, hint: "不动本地已有内容" },
    { value: "skip", label: "合并，跳过同名文件", hint: "只补齐本地缺少的文件" },
    { value: "overwrite", label: "合并，覆盖同名文件", hint: "以远端为准，覆盖全部同名文件" },
  ];
  return (
    <AppDialog title="本地已存在同名项" onClose={() => onResolve(null)}>
      <form
        className="sftp-conflict"
        onSubmit={(event) => {
          event.preventDefault();
          onResolve(policy);
        }}
      >
        <strong>本地已存在同名项</strong>
        <p className="sftp-conflict-target" title={localDir}>
          下载到 {localDir}
        </p>
        <ul className="sftp-conflict-names">
          {shown.map((conflict) => (
            <li key={conflict.name}>
              {conflict.isDir ? "📁" : "📄"} {conflict.name}
            </li>
          ))}
          {conflicts.length > shown.length && <li>…另有 {conflicts.length - shown.length} 项</li>}
        </ul>
        <fieldset>
          <legend className="sr-only">处理方式（应用于全部同名项）</legend>
          {options.map((option) => (
            <label key={option.value} className="sftp-conflict-option">
              <input
                type="radio"
                name="policy"
                value={option.value}
                checked={policy === option.value}
                onChange={() => setPolicy(option.value)}
              />
              <span>
                {option.label}
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="sftp-conflict-actions">
          <Button type="button" variant="ghost" size="sm" onClick={() => onResolve(null)}>
            取消
          </Button>
          <Button type="submit" size="sm">
            开始下载
          </Button>
        </div>
      </form>
    </AppDialog>
  );
}
