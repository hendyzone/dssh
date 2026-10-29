import { describe, expect, it, vi } from "vitest";
import {
  checkForUpdate,
  formatDownloadProgress,
  installUpdate,
  runInstallAndRelaunch,
  type UpdateOffer,
  type UpdaterDeps,
} from "../src/lib/appUpdater";
import { render, screen } from "@testing-library/react";
import UpdatePrompt from "../src/components/UpdatePrompt";

const offer: UpdateOffer = { version: "9.9.9", notes: "测试说明", handle: {} };

function deps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return {
    check: vi.fn().mockResolvedValue(offer),
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    getInstallMode: vi.fn().mockResolvedValue("auto_install"),
    ...overrides,
  };
}

describe("appUpdater logic", () => {
  it("无新版时静默检查不打扰", async () => {
    const d = deps({ check: vi.fn().mockResolvedValue(null) });
    const result = await checkForUpdate(d, { silent: true });
    expect(result).toBeNull();
  });

  it("deb/rpm 只给链接不安装", async () => {
    const d = deps({ getInstallMode: vi.fn().mockResolvedValue("link_only") });
    const result = await installUpdate(offer, d);
    expect(result).toBe("link_only");
    expect(d.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("下载进度：有 contentLength 时显示百分比", () => {
    expect(formatDownloadProgress({ downloadedBytes: 500, percent: 42 })).toBe("下载 42%");
  });

  it("下载进度：无 contentLength 时显示已下载 MB", () => {
    expect(formatDownloadProgress({ downloadedBytes: 2 * 1024 * 1024 })).toBe("已下载 2.0 MB");
  });

  it("downloadAndInstall 失败时不 relaunch", async () => {
    const relaunch = vi.fn();
    const d = deps({
      downloadAndInstall: vi.fn().mockRejectedValue(new Error("签名校验失败")),
    });
    await expect(runInstallAndRelaunch(offer, d, relaunch)).rejects.toThrow(/签名/);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("downloadAndInstall 成功后才 relaunch", async () => {
    const relaunch = vi.fn().mockResolvedValue(undefined);
    await runInstallAndRelaunch(offer, deps(), relaunch);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });
});

describe("UpdatePrompt UI", () => {
  it("有新版时显示提示", () => {
    render(
      <UpdatePrompt
        state={{ kind: "offer", offer, linkOnly: false }}
        onLater={() => {}}
        onInstall={() => {}}
        onOpenRelease={() => {}}
      />,
    );
    expect(screen.getByText(/发现新版本 9\.9\.9/)).toBeTruthy();
    expect(screen.getByText("更新后将自动重启")).toBeTruthy();
  });

  it("deb/rpm 文案与按钮", () => {
    render(
      <UpdatePrompt
        state={{ kind: "offer", offer, linkOnly: true }}
        onLater={() => {}}
        onInstall={() => {}}
        onOpenRelease={() => {}}
      />,
    );
    expect(screen.getByText("此安装方式不支持自动更新")).toBeTruthy();
    expect(screen.getByRole("button", { name: "打开下载页" })).toBeTruthy();
  });

  it("进度对话框显示百分比", () => {
    render(
      <UpdatePrompt
        state={{ kind: "progress", message: "下载 50%" }}
        onLater={() => {}}
        onInstall={() => {}}
        onOpenRelease={() => {}}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("下载 50%");
  });

  it("失败时显示错误", () => {
    render(
      <UpdatePrompt
        state={{ kind: "error", message: "签名校验失败" }}
        onLater={() => {}}
        onInstall={() => {}}
        onOpenRelease={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("签名校验失败");
  });
});
