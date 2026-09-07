import { listen } from "../platform/event";
import type { Event, UnlistenFn } from "../platform/event";

export type TransferDirection = "upload" | "download";
export type TransferStatus = "active" | "done" | "error";

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
}

interface TransferProgressPayload {
  transferId: string;
  direction: TransferDirection;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  done: boolean;
  error?: string | null;
}

type Subscriber = (transfers: Transfer[]) => void;

const transfers = new Map<string, Transfer>();
const subscribers = new Map<string, Set<Subscriber>>();
const listeners = new Map<string, Promise<void>>();
const eventMetrics = new Map<
  string,
  { at: number; bytes: number; speed: number }
>();
let transferSequence = 0;

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
        ...(status === "done" ? {completedAt:previous?.completedAt ?? Date.now()} : {}),
        ...(payload.error ? { error: payload.error } : {}),
      });
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
