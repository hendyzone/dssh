import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import QuotaPanel, { resetQuotaCache } from "../src/components/QuotaPanel";
import fixture from "./fixtures/quota.json?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const one = [{ id: "s1", name: "协同机1", sessionId: "ssh-1" }];
const two = [...one, { id: "s2", name: "协同机2", sessionId: "ssh-2" }];
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const setHidden = (hidden: boolean) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.useFakeTimers();
  resetQuotaCache();
  vi.mocked(invoke).mockResolvedValue({ kind: "ok", body: fixture });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

it("renders channels as remaining percent with colours, reasons and masked accounts", async () => {
  const { container } = render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(invoke).toHaveBeenCalledWith("quota_fetch", { sessionId: "ssh-1" });
  const row = (name: string) => container.querySelector(`[data-channel="${name}"]`) as HTMLElement;
  expect(row("claude").className).toContain("quota-danger");
  expect(within(row("claude")).getByText("剩 7%")).toBeTruthy();
  expect(within(row("claude")).getByText("10-22 18:59 重置")).toBeTruthy();
  expect(row("kimi").className).toContain("quota-warn");
  expect(within(row("kimi")).getByText("未知")).toBeTruthy();
  expect(row("codex").className).toContain("quota-ok");
  expect(within(row("agy")).getByText("Claude/GPT · 每周")).toBeTruthy();
  expect(within(row("agy")).getByText(/账号 a…@example\.com/)).toBeTruthy();
  expect(row("pi-codex").className).toContain("quota-fail");
  expect(within(row("pi-codex")).getByText("FAIL")).toBeTruthy();
  expect(row("pi-codex").textContent).toContain("令牌已过期");
  expect(container.textContent).not.toContain("alice");
  expect(container.textContent).not.toContain("user@example.com");
  expect(within(row("deepseek")).getByText("余额 100.00 CNY")).toBeTruthy();
});

it("explains a server without quota.sh and shows failures without raw output", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ kind: "missing" });
  render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(screen.getByRole("status").textContent).toContain("没有 ~/.amail/client/scripts/quota.sh");
  vi.mocked(invoke).mockResolvedValueOnce({ kind: "failed", message: "quota.sh 运行失败（退出码 1）" });
  fireEvent.click(screen.getByLabelText("刷新额度"));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("quota.sh 运行失败（退出码 1）");
  vi.mocked(invoke).mockRejectedValueOnce("额度查询超时");
  fireEvent.click(screen.getByLabelText("刷新额度"));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("额度查询超时");
  vi.mocked(invoke).mockResolvedValueOnce({ kind: "ok", body: "not json" });
  fireEvent.click(screen.getByLabelText("刷新额度"));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("quota.sh 输出不是 JSON");
});

it("polls every five minutes only while visible and stops on unmount", async () => {
  const view = render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(invoke).toHaveBeenCalledTimes(1);
  await advance(4 * 60_000);
  expect(invoke).toHaveBeenCalledTimes(1);
  await advance(60_000);
  expect(invoke).toHaveBeenCalledTimes(2);
  // Window hidden: no queries even after the result is stale.
  setHidden(true);
  await advance(11 * 60_000);
  expect(invoke).toHaveBeenCalledTimes(2);
  // Back in view with a stale result: one query right away.
  setHidden(false);
  await flush();
  expect(invoke).toHaveBeenCalledTimes(3);
  // Tab not active: no polling.
  view.rerender(<QuotaPanel servers={one} currentId="s1" visible={false} onClose={() => {}} />);
  await advance(11 * 60_000);
  expect(invoke).toHaveBeenCalledTimes(3);
  view.rerender(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(invoke).toHaveBeenCalledTimes(4);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await advance(30 * 60_000);
  expect(invoke).toHaveBeenCalledTimes(4);
});

it("reuses a fresh result when the panel is reopened", async () => {
  const first = render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  first.unmount();
  render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/更新于/)).toBeTruthy();
});

it("switches servers, shows them side by side and flags shared accounts", async () => {
  const { container } = render(<QuotaPanel servers={two} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(invoke).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "s2" } });
  await flush();
  expect(invoke).toHaveBeenLastCalledWith("quota_fetch", { sessionId: "ssh-2" });
  expect(screen.getByLabelText("协同机2 额度")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "__all__" } });
  await flush();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll(".quota-server")).toHaveLength(2);
  const agy = within(screen.getByLabelText("协同机1 额度")).getByText(/共用/);
  expect(agy.textContent).toContain("与 协同机2 · agy 共用");
});
