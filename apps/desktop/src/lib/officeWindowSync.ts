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

/** Only the main App owns data collection. Serialize writes so older renders cannot win. */
export function useOfficePublisher(snapshot: OfficeSnapshot) {
  const latest = useRef(snapshot);
  latest.current = snapshot;
  const publish = useRef<(() => void) | undefined>();
  useEffect(() => {
    let disposed = false, running = false, pending = false;
    let off: (() => void) | undefined;
    const send = async () => {
      pending = true;
      if (running) return;
      running = true;
      try {
        while (pending && !disposed) {
          pending = false;
          const next = () => disposed ? Promise.resolve() : invoke<void>("office_publish_snapshot", { snapshot: latest.current });
          const work = publicationTail.then(next, next);
          publicationTail = work.then(() => {}, () => {});
          await work;
        }
      } catch (error) {
        console.error("Office snapshot publish failed", error);
      } finally { running = false; }
    };
    publish.current = () => { void send(); };
    void listen("office:request", () => { void send(); }, { target: mainTarget }).then(unlisten => {
      if (disposed) unlisten();
      else { off = unlisten; void send(); }
    }).catch(error => console.error("Office request listener failed", error));
    return () => { disposed = true; publish.current = undefined; off?.(); };
  }, []);
  useEffect(() => { publish.current?.(); }, [snapshot]);
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
  const [visible, setVisible] = useState(true);
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
  return visible;
}
