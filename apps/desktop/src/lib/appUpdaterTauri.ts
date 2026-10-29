import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import {
  type DownloadProgress,
  type InstallMode,
  type UpdateOffer,
  type UpdaterDeps,
  checkForUpdate,
  installUpdate,
  runInstallAndRelaunch,
} from "./appUpdater";

function mapUpdate(update: Update): UpdateOffer {
  return {
    version: update.version,
    notes: update.body ?? "",
    handle: update,
  };
}

export function createTauriUpdaterDeps(): UpdaterDeps {
  return {
    check: async () => {
      const update = await check();
      return update ? mapUpdate(update) : null;
    },
    downloadAndInstall: async (handle, onProgress) => {
      const update = handle as Update;
      let downloaded = 0;
      let total: number | undefined;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength;
          onProgress?.({ downloadedBytes: 0, percent: total ? 0 : undefined });
        }
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const percent =
            total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;
          onProgress?.({ downloadedBytes: downloaded, percent });
        }
      });
    },
    getInstallMode: () => invoke<InstallMode>("updater_install_mode"),
    logError: (message) => console.warn("[updater]", message),
  };
}

export async function startupUpdateCheck(
  deps: UpdaterDeps = createTauriUpdaterDeps(),
): Promise<UpdateOffer | null> {
  return checkForUpdate(deps, { silent: true });
}

export async function manualUpdateCheck(
  deps: UpdaterDeps = createTauriUpdaterDeps(),
): Promise<UpdateOffer | null> {
  return checkForUpdate(deps, { silent: false });
}

export async function tauriRelaunch(): Promise<void> {
  await relaunch();
}

export { checkForUpdate, installUpdate, runInstallAndRelaunch };
