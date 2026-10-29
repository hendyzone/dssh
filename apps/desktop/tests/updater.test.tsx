import { describe, expect, it, vi } from "vitest";
import { installVerifiedUpdate, checkForUpdate, type UpdateOffer, type UpdaterDeps } from "../src/lib/appUpdater";
import { render, screen, fireEvent } from "@testing-library/react";
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

  it("有新版时返回 offer", async () => {
    const result = await checkForUpdate(deps(), { silent: false });
    expect(result?.version).toBe("9.9.9");
  });

  it("签名校验失败不调用安装", async () => {
    const d = deps();
    await expect(installVerifiedUpdate(offer, d, false)).rejects.toThrow(/签名校验失败/);
    expect(d.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("deb/rpm 只给链接不安装", async () => {
    const d = deps({ getInstallMode: vi.fn().mockResolvedValue("link_only") });
    const result = await installVerifiedUpdate(offer, d, true);
    expect(result).toBe("link_only");
    expect(d.downloadAndInstall).not.toHaveBeenCalled();
  });

  it("变异：校验失败仍调用安装应被上层拒绝", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    const d = deps({ downloadAndInstall: install });
    let called = false;
    try {
      await installVerifiedUpdate(offer, d, false);
    } catch {
      called = true;
    }
    expect(called).toBe(true);
    expect(install).not.toHaveBeenCalled();
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
    expect(screen.getByRole("button", { name: "更新" })).toBeTruthy();
  });

  it("无新版不渲染", () => {
    const { container } = render(
      <UpdatePrompt state={{ kind: "idle" }} onLater={() => {}} onInstall={() => {}} onOpenRelease={() => {}} />,
    );
    expect(container.textContent).toBe("");
  });

  it("失败时显示错误", () => {
    render(
      <UpdatePrompt
        state={{ kind: "error", message: "签名校验失败，已拒绝安装" }}
        onLater={() => {}}
        onInstall={() => {}}
        onOpenRelease={() => {}}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("签名校验失败");
  });

  it("deb/rpm 只给下载链接", () => {
    render(
      <UpdatePrompt
        state={{ kind: "offer", offer, linkOnly: true }}
        onLater={() => {}}
        onInstall={() => {}}
        onOpenRelease={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "打开下载页" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "更新" })).toBeNull();
  });
});

describe("installVerifiedUpdate mutation guard", () => {
  it("verified=false 时 install 不被调用（红）", async () => {
    const install = vi.fn();
    await expect(installVerifiedUpdate(offer, deps({ downloadAndInstall: install }), false)).rejects.toThrow();
    expect(install).not.toHaveBeenCalled();
  });

  it("verified=true 时 install 被调用（绿）", async () => {
    const install = vi.fn().mockResolvedValue(undefined);
    await installVerifiedUpdate(offer, deps({ downloadAndInstall: install }), true);
    expect(install).toHaveBeenCalledTimes(1);
  });
});
