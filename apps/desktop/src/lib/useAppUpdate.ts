import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateOffer } from "./appUpdater";
import type { UpdatePromptState } from "../components/UpdatePrompt";
import {
  createTauriUpdaterDeps,
  runInstallAndRelaunch,
  startupUpdateCheck,
  tauriRelaunch,
} from "./appUpdaterTauri";

export function useAppUpdate() {
  const [prompt, setPrompt] = useState<UpdatePromptState>({ kind: "idle" });

  const presentOffer = useCallback((offer: UpdateOffer, linkOnly: boolean) => {
    setPrompt({ kind: "offer", offer, linkOnly });
  }, []);

  const showOffer = useCallback(async (offer: UpdateOffer) => {
    const mode = await invoke<"auto_install" | "link_only">("updater_install_mode");
    presentOffer(offer, mode === "link_only");
  }, [presentOffer]);

  useEffect(() => {
    if (import.meta.env.MODE === "test") return;
    void (async () => {
      const offer = await startupUpdateCheck();
      if (offer) await showOffer(offer);
    })();
  }, [showOffer]);

  const dismiss = () => setPrompt({ kind: "idle" });

  const openRelease = () => {
    window.open("https://github.com/hendyzone/dssh/releases/latest", "_blank");
    dismiss();
  };

  const install = async () => {
    if (prompt.kind !== "offer") return;
    setPrompt({ kind: "progress", message: "准备下载…" });
    try {
      const deps = createTauriUpdaterDeps();
      await runInstallAndRelaunch(
        prompt.offer,
        deps,
        tauriRelaunch,
        (message) => setPrompt({ kind: "progress", message }),
      );
    } catch (error) {
      setPrompt({ kind: "error", message: String(error) });
    }
  };

  return { prompt, dismiss, openRelease, install, presentOffer };
}
