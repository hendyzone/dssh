import { confirm } from "@tauri-apps/plugin-dialog";

/** Tauri's injected window.confirm is asynchronous and uses an obsolete command. */
export async function confirmAction(message: string): Promise<boolean> {
  if ("__TAURI_INTERNALS__" in window) {
    return confirm(message, { title: "dssh", kind: "warning" });
  }
  // Keep native confirmation for the browser preview.
  return window.confirm(message);
}
