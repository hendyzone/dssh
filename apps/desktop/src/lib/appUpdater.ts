/** 应用内更新：可单测的逻辑与 Tauri 封装分离。 */

export const UPDATER_JSON_ENDPOINT =
  "https://github.com/hendyzone/dssh/releases/latest/download/latest.json";
export const RELEASE_PAGE = "https://github.com/hendyzone/dssh/releases/latest";

export type InstallMode = "auto_install" | "link_only";

export interface UpdateOffer {
  version: string;
  notes: string;
  /** plugin-updater 返回的 update 对象，安装时原样传入 */
  handle: unknown;
}

export interface UpdaterDeps {
  check: () => Promise<UpdateOffer | null>;
  downloadAndInstall: (handle: unknown) => Promise<void>;
  getInstallMode: () => Promise<InstallMode>;
  logError?: (message: string) => void;
}

export async function checkForUpdate(
  deps: UpdaterDeps,
  options: { silent: boolean },
): Promise<UpdateOffer | null> {
  try {
    return await deps.check();
  } catch (error) {
    const message = String(error);
    if (options.silent) {
      deps.logError?.(message);
      return null;
    }
    throw error;
  }
}

/** verified=false 或 link_only 时不得调用 downloadAndInstall。 */
export async function installVerifiedUpdate(
  offer: UpdateOffer,
  deps: UpdaterDeps,
  verified: boolean,
): Promise<"installed" | "link_only"> {
  const mode = await deps.getInstallMode();
  if (mode === "link_only") {
    return "link_only";
  }
  if (!verified) {
    throw new Error("签名校验失败，已拒绝安装");
  }
  await deps.downloadAndInstall(offer.handle);
  return "installed";
}
