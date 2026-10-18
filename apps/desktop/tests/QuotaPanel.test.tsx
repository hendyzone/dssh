import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import QuotaPanel, { resetQuotaCache } from "../src/components/QuotaPanel";
import fixture from "./fixtures/quota.json?raw";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const one = [{ id: "s1", name: "server-a", sessionId: "ssh-1" }];
const two = [...one, { id: "s2", name: "server-b", sessionId: "ssh-2" }];
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
  // agy: Claude/GPT pool exhausted but Gemini still usable — card warns, not red.
  expect(row("agy").className).toContain("quota-warn");
  expect(row("agy").className).not.toContain("quota-danger");
  expect(within(row("agy")).getByText("Gemini 80% · Claude/GPT 0%")).toBeTruthy();
  expect(within(row("agy")).queryByText("剩 0%")).toBeNull();
  const fill = (label: string) =>
    within(row("agy")).getByRole("meter", { name: `agy ${label} 剩余` }).firstElementChild!.className;
  expect(fill("Claude/GPT · 每周")).toContain("quota-fill-danger");
  expect(fill("Gemini · 每周")).toContain("quota-fill-ok");
  // A 0% bar has no visible fill, so the row's value carries the red too.
  expect(within(row("agy")).getByText("0%").className).toContain("quota-value-danger");
  expect(within(row("agy")).getByText("80%").className).not.toContain("quota-value-danger");
  expect(within(row("agy")).getByText("10-21 06:03 重置")).toBeTruthy();
  expect(row("kimi").className).toContain("quota-warn");
  expect(within(row("kimi")).getByText("未知")).toBeTruthy();
  expect(row("codex").className).toContain("quota-ok");
  expect(within(row("agy")).getByText("Claude/GPT · 每周")).toBeTruthy();
  expect(within(row("agy")).getByText(/账号 a…@example\.com/)).toBeTruthy();
  expect(row("claude").className).toContain("quota-fail");
  expect(within(row("claude")).getByText("FAIL")).toBeTruthy();
  expect(row("claude").textContent).toContain("access token 已过期");
  expect(container.textContent).not.toContain("alice");
  expect(container.textContent).not.toContain("user@example.com");
  expect(within(row("deepseek")).getByText("余额 100.00 CNY")).toBeTruthy();
});

it("paints a multi-pool card red only when every pool is exhausted", async () => {
  const body = JSON.stringify({ meta: {}, channels: {
    agy: { ok: true, pools: [
      { pool: "Gemini Models", pool_id: "gemini", limit: "week", left_pct: 8 },
      { pool: "Claude and GPT models", pool_id: "claude_gpt", limit: "week", left_pct: 0 },
    ] },
    claude: { ok: true, five_hour_pct: 50, seven_day_pct: 93 },
  } });
  vi.mocked(invoke).mockResolvedValue({ kind: "ok", body });
  const { container } = render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  const row = (name: string) => container.querySelector(`[data-channel="${name}"]`) as HTMLElement;
  expect(row("agy").className).toContain("quota-danger");
  expect(within(row("agy")).getByText("Gemini 8% · Claude/GPT 0%")).toBeTruthy();
  // Single-pool channel is unchanged: 剩 X% of the lowest window, coloured by it.
  expect(row("claude").className).toContain("quota-danger");
  expect(within(row("claude")).getByText("剩 7%")).toBeTruthy();
});

it("explains a server without python3 and shows failures without raw output", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({ kind: "noPython" });
  render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  expect(screen.getByRole("status").textContent).toContain("没有 python3");
  vi.mocked(invoke).mockResolvedValueOnce({ kind: "failed", message: "额度脚本运行失败（退出码 1）" });
  fireEvent.click(screen.getByLabelText("刷新额度"));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("额度脚本运行失败（退出码 1）");
  vi.mocked(invoke).mockRejectedValueOnce("额度查询超时");
  fireEvent.click(screen.getByLabelText("刷新额度"));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("额度查询超时");
  vi.mocked(invoke).mockResolvedValueOnce({ kind: "ok", body: "not json" });
  fireEvent.click(screen.getByLabelText("刷新额度"));
  await flush();
  expect(screen.getByRole("alert").textContent).toBe("额度脚本输出不是 JSON");
});

it("copies a setup prompt for the server and confirms with 已复制", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  render(<QuotaPanel servers={one} currentId="s1" visible onClose={() => {}} />);
  await flush();
  const button = screen.getByLabelText("复制 server-a 的额度提示词");
  expect(button.textContent).toContain("复制提示词");
  fireEvent.click(button);
  await flush();
  expect(writeText).toHaveBeenCalledTimes(1);
  const prompt = writeText.mock.calls[0][0] as string;
  expect(prompt).toContain("登录令牌已过期（claude）");
  expect(prompt).toContain("令牌已过期");
  expect(prompt).not.toContain("example.com");
  expect(prompt).not.toContain("abcdefghijklmnop");
  expect(button.textContent).toContain("已复制");
  await advance(2500);
  expect(button.textContent).toContain("复制提示词");
  writeText.mockRejectedValueOnce(new Error("denied"));
  fireEvent.click(button);
  await flush();
  expect(screen.getByRole("alert").textContent).toContain("复制失败");
  expect((screen.getByLabelText("server-a 的额度提示词") as HTMLTextAreaElement).value).toBe(prompt);
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
  expect(screen.getByLabelText("server-b 额度")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("服务器"), { target: { value: "__all__" } });
  await flush();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(container.querySelectorAll(".quota-server")).toHaveLength(2);
  const agy = within(screen.getByLabelText("server-a 额度")).getByText(/共用/);
  expect(agy.textContent).toContain("与 server-b · agy 共用");
});
