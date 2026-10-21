import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { OfficeSnapshot } from "./teamOffice";

export interface OfficeEnvelope { epoch: string; sequence: number; snapshot: OfficeSnapshot; }
interface OfficeInitial { snapshot: OfficeEnvelope | null; visible: boolean; }
const officeTarget = { kind: "WebviewWindow" as const, label: "office" };
const mainTarget = { kind: "WebviewWindow" as const, label: "main" };
// Survives StrictMode effect replacement: an older in-flight IPC finishes before a new publisher.
let publicationTail: Promise<void> = Promise.resolve();

export function openOfficeWindow(): Promise<void> { return invoke("open_office_window"); }

/** Content deduplication and one trailing update per 250ms, only while the popup exists. */
export function useOfficePublisher(snapshot: OfficeSnapshot, officeExists = false) {
  const content = officeExists ? JSON.stringify(snapshot) : "";
  const latest = useRef({snapshot, content, officeExists});
  latest.current = {snapshot, content, officeExists};
  const request = useRef<(() => void) | undefined>();
  const lastSent = useRef<string>();
  const cycle = useRef(0);
  const cancelTimer = useRef<(() => void) | undefined>();
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let off: (() => void) | undefined;
    const schedule = () => {
      if (disposed || !latest.current.officeExists || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        const send = async () => {
          if (disposed || !latest.current.officeExists || lastSent.current === latest.current.content) return;
          const next = latest.current;
          const generation = cycle.current;
          await invoke<void>("office_publish_snapshot", {snapshot:next.snapshot});
          if (!disposed && latest.current.officeExists && generation === cycle.current) lastSent.current = next.content;
        };
        const work = publicationTail.then(send, send);
        publicationTail = work.catch(error => console.error("Office snapshot publish failed", error));
      }, 250);
    };
    request.current = schedule;
    cancelTimer.current = () => { if(timer !== undefined) clearTimeout(timer); timer = undefined; };
    void listen("office:request", () => { schedule(); }, {target:mainTarget}).then(unlisten => {
      if (disposed) unlisten(); else { off = unlisten; schedule(); }
    }).catch(error => console.error("Office request listener failed", error));
    schedule();
    return () => { disposed = true; if (timer !== undefined) clearTimeout(timer); off?.(); request.current = undefined; };
  }, []);
  useEffect(() => {
    if (!officeExists) { cycle.current++; lastSent.current = undefined; cancelTimer.current?.(); }
    request.current?.();
  }, [content, officeExists]);
}

/** Presence is native lifecycle state, independent of the child React startup. */
export function useOfficePresence() {
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let disposed = false, received = false;
    let off: (() => void) | undefined;
    void listen<boolean>("office:presence", event => {
      if (!disposed) { received = true; setExists(event.payload); }
    }, {target:mainTarget}).then(async unlisten => {
      if (disposed) { unlisten(); return; }
      off = unlisten;
      const initial = await invoke<boolean>("office_window_exists");
      if (!disposed && !received) setExists(initial);
    }).catch(error => console.error("Office presence unavailable", error));
    return () => { disposed = true; off?.(); };
  }, []);
  return exists;
}

/** Subscribe before pulling the cache; a newer broadcast must beat a delayed initial reply. */
export function useOfficeSnapshot() {
  const [snapshot, setSnapshot] = useState<OfficeSnapshot>();
  const [visible, setVisible] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let current: OfficeEnvelope | undefined;
    let visibilityReceived = false;
    const cleanups: (() => void)[] = [];
    const receive = (next: OfficeEnvelope | null) => {
      if (disposed || !next || next.snapshot?.version !== 1 || !Number.isSafeInteger(next.sequence) || next.sequence < 1) return;
      // An office window belongs to one native process; another epoch is never authoritative.
      if (current && (next.epoch !== current.epoch || next.sequence <= current.sequence)) return;
      current = next;
      setSnapshot(next.snapshot);
      setError("");
    };
    const register = async (promise: Promise<() => void>) => {
      const off = await promise;
      if (disposed) off(); else cleanups.push(off);
    };
    void (async () => {
      await register(listen<OfficeEnvelope>("office:snapshot", event => receive(event.payload), { target: officeTarget }));
      if (disposed) return;
      await register(listen<boolean>("office:visibility", event => {
        if (!disposed) { visibilityReceived = true; setVisible(event.payload); }
      }, { target: officeTarget }));
      if (disposed) return;
      const initial = await invoke<OfficeInitial>("office_request_snapshot");
      if (disposed) return;
      if (!visibilityReceived) setVisible(initial.visible);
      receive(initial.snapshot);
    })().catch(reason => { if (!disposed) setError(`房间同步失败：${String(reason)}`); });
    return () => { disposed = true; cleanups.forEach(off => off()); };
  }, []);
  return { snapshot, visible, error };
}

/** Native minimize state complements WebView document visibility, without a polling clock. */
export function useMainWindowVisibility() {
  const [visible, setVisible] = useState(false);
  const [documentHidden, setDocumentHidden] = useState(() => document.hidden);
  useEffect(() => { const changed = () => setDocumentHidden(document.hidden); document.addEventListener("visibilitychange", changed); return () => document.removeEventListener("visibilitychange", changed); }, []);
  useEffect(() => {
    let disposed = false, received = false;
    let off: (() => void) | undefined;
    void listen<boolean>("office:main-visibility", event => {
      if (!disposed) { received = true; setVisible(event.payload); }
    }, { target: mainTarget }).then(async unlisten => {
      if (disposed) { unlisten(); return; }
      off = unlisten;
      const initial = await invoke<boolean>("office_main_visibility");
      if (!disposed && !received) setVisible(initial);
    }).catch(error => console.error("Main window visibility unavailable", error));
    return () => { disposed = true; off?.(); };
  }, []);
  return visible && !documentHidden;
}
