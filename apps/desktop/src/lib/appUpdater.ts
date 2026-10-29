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

export type DownloadProgress = {
  downloadedBytes: number;
  /** 0–100；无 contentLength 时为 undefined */
  percent?: number;
};

export interface UpdaterDeps {
  check: () => Promise<UpdateOffer | null>;
  downloadAndInstall: (
    handle: unknown,
    onProgress?: (progress: DownloadProgress) => void,
  ) => Promise<void>;
  getInstallMode: () => Promise<InstallMode>;
  logError?: (message: string) => void;
}

export function formatDownloadProgress(progress: DownloadProgress): string {
  if (progress.percent != null) {
    return `下载 ${progress.percent}%`;
  }
  const mb = progress.downloadedBytes / (1024 * 1024);
  return `已下载 ${mb.toFixed(1)} MB`;
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

/** link_only 时不调用 downloadAndInstall；签名校验由插件在 downloadAndInstall 内完成。 */
export async function installUpdate(
  offer: UpdateOffer,
  deps: UpdaterDeps,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<"installed" | "link_only"> {
  const mode = await deps.getInstallMode();
  if (mode === "link_only") {
    return "link_only";
  }
  await deps.downloadAndInstall(offer.handle, onProgress);
  return "installed";
}

/** 下载安装成功后重启；downloadAndInstall 抛错时不应调用 relaunch。 */
export async function runInstallAndRelaunch(
  offer: UpdateOffer,
  deps: UpdaterDeps,
  relaunch: () => Promise<void>,
  onProgress?: (message: string) => void,
): Promise<void> {
  const report = (p: DownloadProgress) => onProgress?.(formatDownloadProgress(p));
  await installUpdate(offer, deps, report);
  await relaunch();
}
