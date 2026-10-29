import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import {
  type InstallMode,
  type UpdateOffer,
  type UpdaterDeps,
  checkForUpdate,
  installVerifiedUpdate,
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
    downloadAndInstall: async (handle) => {
      const update = handle as Update;
      let downloaded = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Progress") {
          downloaded = event.data.chunkLength + downloaded;
        }
      });
      await relaunch();
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

export { checkForUpdate, installVerifiedUpdate };
