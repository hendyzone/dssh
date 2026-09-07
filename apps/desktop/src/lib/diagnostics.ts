import { invoke } from "@tauri-apps/api/core";

export function installDiagnostics() {
  let count = 0;
  let intervalStart = Date.now();
  const report = (message: string, stack = "") => {
    if (Date.now() - intervalStart > 60_000) { count = 0; intervalStart = Date.now(); }
    if (++count > 30) return;
    void invoke("desktop_report_error", { message: message.slice(0, 4000), stack: stack.slice(0, 8000) }).catch(() => {});
  };
  const onError = (event: ErrorEvent) => report(event.message, event.error?.stack ?? `${event.filename}:${event.lineno}:${event.colno}`);
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    report(`Unhandled promise rejection: ${reason instanceof Error ? reason.message : String(reason)}`, reason instanceof Error ? reason.stack : "");
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
