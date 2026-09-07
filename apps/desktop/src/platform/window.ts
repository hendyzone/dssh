import { invoke } from "./core";
import { listen } from "./event";
let closeSubscription = 0;
export function getCurrentWindow() {
  return {
    async onCloseRequested(handler: (event: { preventDefault(): void }) => void | Promise<void>) {
      const token = String(++closeSubscription);
      const off = await listen("desktop://close-requested", () => handler({ preventDefault() {} }));
      try { await invoke("desktop_close_guard", { enabled: true, token }); }
      catch (error) { off(); throw error; }
      return () => { off(); void invoke("desktop_close_guard", { enabled: false, token }).catch(() => {}); };
    },
    destroy: () => invoke<void>("desktop_destroy"),
    close: () => invoke<void>("desktop_close"),
  };
}
