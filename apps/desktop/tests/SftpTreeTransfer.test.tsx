import { render, screen, fireEvent } from "@testing-library/react";
import { it, expect, vi } from "vitest";
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
import { FolderConflictDialog, TreeTransferItem } from "../src/components/SftpTreeTransfer";
import { emptyTreeProgress, type Transfer, type TreeProgress } from "../src/lib/transfers";

function transfer(status: Transfer["status"], tree: Partial<TreeProgress>, extra: Partial<Transfer> = {}): Transfer {
  return {
    transferId: "t1", sessionId: "s", direction: "download", fileName: "项目 A",
    transferredBytes: 0, totalBytes: 0, speedBytesPerSecond: 0, status,
    tree: { ...emptyTreeProgress(), ...tree }, ...extra,
  };
}

it("shows the counting phase with discovered files and an indeterminate bar", () => {
  const onCancel = vi.fn();
  render(<TreeTransferItem transfer={transfer("active", { phase: "scanning", discoveredFiles: 812 })} onCancel={onCancel} />);
  expect(screen.getByText("正在统计… 已发现 812 个文件")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it("shows file counts, bytes, speed and the current file while transferring", () => {
  render(<TreeTransferItem onCancel={() => {}} transfer={transfer("active",
    { phase: "transferring", totalFiles: 3000, completedFiles: 1200, currentFile: "项目 A/子目录/报告 1.txt" },
    { transferredBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024, speedBytesPerSecond: 6 * 1024 * 1024 })} />);
  expect(screen.getByText("1200/3000 个文件 · 50 MB / 200 MB")).toBeTruthy();
  expect(screen.getByText("6.0 MB/s")).toBeTruthy();
  expect(screen.getByText("项目 A/子目录/报告 1.txt")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("25");
});

it("reports cancellation with completed / total files", () => {
  render(<TreeTransferItem onCancel={() => {}} transfer={transfer("canceled",
    { phase: "done", canceled: true, totalFiles: 40, completedFiles: 12 })} />);
  expect(screen.getByText("已取消（12/40 个文件已完成）")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  expect(screen.getByRole("button", { name: "关闭传输提示：项目 A" })).toBeTruthy();
});

it("summarises partial failures and expands failures and skipped links", () => {
  render(<TreeTransferItem onCancel={() => {}} transfer={transfer("done", {
    phase: "done", totalFiles: 10, completedFiles: 8, downloadedFiles: 7, skippedExisting: 1,
    failureCount: 2, skippedCount: 1,
    failures: [{ path: "/srv/a/secret.txt", reason: "Permission denied" }, { path: "/srv/a/locked", reason: "无法读取目录" }],
    skipped: [{ path: "/srv/a/loop", reason: "目录符号链接（未跟随）" }],
  })} />);
  expect(screen.getByText("完成：7 个文件已下载，1 个已存在跳过，2 个失败")).toBeTruthy();
  expect(screen.queryByLabelText("失败与跳过明细")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /查看 2 个失败/ }));
  const list = screen.getByLabelText("失败与跳过明细");
  expect(list.textContent).toContain("/srv/a/secret.txt");
  expect(list.textContent).toContain("Permission denied");
  expect(list.textContent).toContain("目录符号链接（未跟随）");
});

it("offers one batch-wide conflict choice", () => {
  const onResolve = vi.fn();
  render(<FolderConflictDialog localDir="/home/me/下载" onResolve={onResolve}
    conflicts={[{ name: "项目 A", isDir: true, renameTo: "项目 A (1)" }]} />);
  expect(screen.getByText("另存为 “项目 A (1)”")).toBeTruthy();
  fireEvent.click(screen.getByLabelText(/合并，跳过同名文件/));
  fireEvent.click(screen.getByRole("button", { name: "开始下载" }));
  expect(onResolve).toHaveBeenCalledWith("skip");
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(onResolve).toHaveBeenLastCalledWith(null);
});
