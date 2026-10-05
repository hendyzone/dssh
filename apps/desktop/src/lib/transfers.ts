import { listen } from "@tauri-apps/api/event";
import type { Event, UnlistenFn } from "@tauri-apps/api/event";

export type TransferDirection = "upload" | "download";
export type TransferStatus = "active" | "done" | "error" | "canceled";

export interface TransferIssue {
  path: string;
  reason: string;
}

/** 文件夹 / 多选下载：整体作为一个传输项，附带文件计数与失败明细。 */
export interface TreeProgress {
  phase: "scanning" | "transferring" | "done";
  discoveredFiles: number;
  totalFiles: number;
  completedFiles: number;
  downloadedFiles: number;
  skippedExisting: number;
  currentFile: string;
  failureCount: number;
  skippedCount: number;
  failures: TransferIssue[];
  skipped: TransferIssue[];
  localRoots: string[];
  canceled: boolean;
}

export function emptyTreeProgress(): TreeProgress {
  return {
    phase: "scanning",
    discoveredFiles: 0,
    totalFiles: 0,
    completedFiles: 0,
    downloadedFiles: 0,
    skippedExisting: 0,
    currentFile: "",
    failureCount: 0,
    skippedCount: 0,
    failures: [],
    skipped: [],
    localRoots: [],
    canceled: false,
  };
}

/** 有失败、跳过或被取消的文件夹传输需要用户看完再关，不自动消失。 */
export function treeNeedsAttention(transfer: Transfer): boolean {
  const tree = transfer.tree;
  return !!tree && (tree.canceled || tree.failureCount > 0 || tree.skippedCount > 0);
}

export interface Transfer {
  transferId: string;
  sessionId: string;
  direction: TransferDirection;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  status: TransferStatus;
  error?: string;
  completedAt?: number;
  tree?: TreeProgress;
}

interface TransferProgressPayload {
  transferId: string;
  direction: TransferDirection;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string | null;
  tree?: TreeProgress | null;
}

type Subscriber = (transfers: Transfer[]) => void;

const transfers = new Map<string, Transfer>();
const subscribers = new Map<string, Set<Subscriber>>();
const listeners = new Map<string, Promise<void>>();
const eventMetrics = new Map<
  string,
  { at: number; bytes: number; speed: number }
>();
const dismissalTimers = new Map<string, ReturnType<typeof setTimeout>>();
let transferSequence = 0;

/** Dismiss only finished transfers; active work must remain visible/cancelable. */
export function dismissTransfer(transferId: string): void {
  const transfer = transfers.get(transferId);
  if (!transfer || transfer.status === "active") return;
  clearTimeout(dismissalTimers.get(transferId));
  dismissalTimers.delete(transferId);
  transfers.delete(transferId);
  eventMetrics.delete(transferId);
  notify(transfer.sessionId);
}

function eventName(sessionId: string): string {
  return `sftp://${sessionId}/upload-progress`;
}

function notify(sessionId: string): void {
  const sessionTransfers = [...transfers.values()].filter(
    (transfer) => transfer.sessionId === sessionId,
  );
  subscribers
    .get(sessionId)
    ?.forEach((subscriber) => subscriber(sessionTransfers));
}

function ensureListener(sessionId: string): void {
  if (listeners.has(sessionId)) return;

  const registration = listen<TransferProgressPayload>(
    eventName(sessionId),
    (event: Event<TransferProgressPayload>) => {
      const payload = event.payload;
      const previous = transfers.get(payload.transferId);
      const now = performance.now();
      const metrics = eventMetrics.get(payload.transferId);
      const byteDelta = payload.transferredBytes - (metrics?.bytes ?? 0);
      const speed =
        metrics && now > metrics.at && byteDelta > 0
          ? (byteDelta * 1000) / (now - metrics.at)
          : (metrics?.speed ?? 0);
      eventMetrics.set(payload.transferId, {
        at: now,
        bytes: payload.transferredBytes,
        speed,
      });
      const status: TransferStatus = payload.error
        ? "error"
        : payload.tree?.canceled && payload.done
          ? "canceled"
          : payload.done
            ? "done"
            : "active";

      transfers.set(payload.transferId, {
        transferId: payload.transferId,
        sessionId: previous?.sessionId ?? sessionId,
        direction: payload.direction,
        fileName: payload.fileName,
        transferredBytes: payload.transferredBytes,
        totalBytes: payload.totalBytes,
        speedBytesPerSecond: speed,
        status,
        ...(status !== "active" ? {completedAt:previous?.completedAt ?? Date.now()} : {}),
        ...(payload.error ? { error: payload.error } : {}),
        ...(payload.tree ? { tree: payload.tree } : previous?.tree ? { tree: previous.tree } : {}),
      });
      const current = transfers.get(payload.transferId)!;
      if (
        status !== "active" &&
        !dismissalTimers.has(payload.transferId) &&
        !treeNeedsAttention(current)
      ) {
        dismissalTimers.set(payload.transferId, setTimeout(
          () => dismissTransfer(payload.transferId),
          status === "error" ? 10_000 : 5_000,
        ));
      }
      notify(sessionId);
    },
  )
    .then((cleanup: UnlistenFn) => {
      // 监听器故意保持到应用退出，避免面板卸载时错过传输终态。
      void cleanup;
    })
    .catch(() => {
      // 监听失败时允许后续重新订阅重试。
      listeners.delete(sessionId);
    });
  listeners.set(sessionId, registration);
}

export async function waitForTransferListener(
  sessionId: string,
): Promise<void> {
  ensureListener(sessionId);
  await listeners.get(sessionId);
}

export function createTransfer(
  sessionId: string,
  fileName: string,
  direction: TransferDirection,
  kind: "file" | "tree" = "file",
): string {
  ensureListener(sessionId);
  const randomId = globalThis.crypto?.randomUUID?.();
  const transferId = randomId ?? `transfer-${Date.now()}-${transferSequence++}`;
  eventMetrics.delete(transferId);
  transfers.set(transferId, {
    transferId,
    sessionId,
    direction,
    fileName,
    transferredBytes: 0,
    totalBytes: 0,
    speedBytesPerSecond: 0,
    status: "active",
    ...(kind === "tree" ? { tree: emptyTreeProgress() } : {}),
  });
  notify(sessionId);
  return transferId;
}

export function subscribeTransfers(
  sessionId: string,
  subscriber: Subscriber,
): () => void {
  ensureListener(sessionId);
  const sessionSubscribers =
    subscribers.get(sessionId) ?? new Set<Subscriber>();
  sessionSubscribers.add(subscriber);
  subscribers.set(sessionId, sessionSubscribers);
  subscriber(
    [...transfers.values()].filter(
      (transfer) => transfer.sessionId === sessionId,
    ),
  );
  return () => {
    sessionSubscribers.delete(subscriber);
    if (sessionSubscribers.size === 0) subscribers.delete(sessionId);
  };
}

export function transferPercent(transfer: Transfer): number {
  if (transfer.totalBytes <= 0) return transfer.status === "done" ? 100 : 0;
  return Math.min(
    100,
    Math.round((transfer.transferredBytes / transfer.totalBytes) * 100),
  );
}

export function formatTransferSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
