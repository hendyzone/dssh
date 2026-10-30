import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getVersion } from "@tauri-apps/api/app";
import { compareVersions, parseChangelog, updateEntries } from "../src/lib/changelog";
import UpdatePrompt from "../src/components/UpdatePrompt";
import UpdateSettingsSection from "../src/components/UpdateSettingsSection";
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../src/lib/appUpdaterTauri", () => ({ manualUpdateCheck: vi.fn() }));
const markdown = `# 更新日志
## v1.2.30（2026-10-30）
- future
## v1.2.27（2026-10-29）
- newest
## v1.2.25（2026-10-26）
- middle
## v1.2.26（2026-10-29）
- second
## v1.2.24（2026-10-26）
- installed
## v1.2.23（2026-10-26）
- older
`;
beforeEach(() => {
  vi.mocked(getVersion).mockResolvedValue("1.2.24");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, text: async () => markdown }));
});
afterEach(() => vi.unstubAllGlobals());
function prompt(version = "1.2.27", notes = "- fallback") {
  return <UpdatePrompt state={{kind: "offer", offer: {version, notes, handle: {}}, linkOnly: false}} onLater={() => {}} onInstall={() => {}} onOpenRelease={() => {}}/>;
}
it("sorts all interval entries newest first, excluding installed and future versions", () => {
  expect(updateEntries(markdown, "1.2.24", "1.2.27").map(x => x.version)).toEqual(["1.2.27", "1.2.26", "1.2.25"]);
  expect(updateEntries(markdown, "1.2.27", "1.2.27")).toEqual([]);
  expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
  expect(compareVersions("2.0.0-beta.10", "2.0.0-beta.2")).toBeGreaterThan(0);
  expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBeGreaterThan(0);
});
it("parses one section without absorbing unversioned headings", () => {
  expect(parseChangelog('## v1.2.27（2026-10-29）\n- yes\n## 其他\n- no')).toEqual([{version: "1.2.27", date: "2026-10-29", body: "- yes"}]);
});
it("renders every newer version in the update prompt using the target tag URL", async () => {
  render(prompt());
  await screen.findByText("middle");
  expect(screen.getAllByRole("heading", {level: 3}).map(x => x.textContent?.slice(0,7))).toEqual(["v1.2.27", "v1.2.26", "v1.2.25"]);
  expect(screen.queryByText("installed")).toBeNull();
  expect(screen.queryByText("future")).toBeNull();
  expect(screen.queryByText("fallback")).toBeNull();
  expect(fetch).toHaveBeenCalledWith("https://raw.githubusercontent.com/hendyzone/dssh/v1.2.27/CHANGELOG.md", expect.objectContaining({signal: expect.any(AbortSignal)}));
});
it.each(["network", "http", "missing target"])("falls back to notes for %s failures", async failure => {
  vi.mocked(fetch).mockImplementation(async () => {
    if (failure === "network") throw new Error("offline");
    return {ok: failure !== "http", status: 404, text: async () => '# empty'} as Response;
  });
  render(prompt("1.2.27", "## v1.2.27（2026-10-29）\n- fallback"));
  await act(async () => {});
  expect(screen.getByText("fallback")).toBeTruthy();
  expect(screen.getAllByRole("heading", {level: 3})).toHaveLength(1);
  expect(screen.getByRole("button", {name: "更新"})).toBeTruthy();
});
it("shows only version when remote and notes are unavailable", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  render(prompt("1.2.27", ""));
  await act(async () => {});
  expect(screen.getByRole("heading", {level: 3}).textContent).toBe("v1.2.27");
  expect(screen.queryByRole("list")).toBeNull();
});
it("ignores a late response after changing the offered version", async () => {
  let resolve!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const view = render(prompt());
  await waitFor(() => expect(resolve).toBeTruthy());
  view.rerender(prompt("1.2.26"));
  await screen.findByText("second");
  await act(async () => resolve({ok: true, text: async () => markdown} as Response));
  expect(screen.queryByText("newest")).toBeNull();
});
it("settings shows bundled installed-and-earlier history without any network", async () => {
  render(<UpdateSettingsSection onUpdateFound={() => {}}/>);
  await screen.findByText("1.2.24");
  fireEvent.click(screen.getByText("更新日志"));
  expect(screen.getAllByRole("heading", {level: 3}).map(x => x.textContent?.slice(0,7))).toEqual(["v1.2.24", "v1.2.23", "v1.2.22", "v1.2.21", "v1.2.20"]);
  expect(screen.getByText(/跟随当前终端时通过团队名单匹配 Lead/)).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});
