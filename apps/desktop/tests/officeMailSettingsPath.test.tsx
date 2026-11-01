import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dssh/T85: the office / team dynamics mail bar tells users where to turn the mailbox on. Follow the
// path it prints through the real settings dialog, so a renamed tab or section turns this red.
// Only the native bridge is stubbed; the mail bar text and the settings UI are production code.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import TeamOffice from "../src/components/TeamOffice";
import SettingsModal from "../src/components/SettingsModal";
import { defaultSettings } from "../src/store";
import type { OfficeSnapshot } from "../src/lib/teamOffice";

const unconfigured: OfficeSnapshot = {
  version: 1, themeId: "one-light", animationEnabled: true, mailAvailability: "unavailable",
  projects: [{ id: "p1", name: "alpha", sources: [{ id: "s1", label: "alpha", availability: "ready", notice: "", members: [] }] }],
};

beforeEach(() => { localStorage.clear(); });

function mailBarHint(): string {
  const view = render(<TeamOffice snapshot={unconfigured}/>);
  const text = screen.getByText(/邮件动态未配置/).textContent ?? "";
  view.unmount();
  return text;
}

it("points the unconfigured mail bar at the real settings location", () => {
  const hint = mailBarHint();
  expect(hint).toContain("「设置 → 团队 → 高级：按会话的 Agent 协作（邮件）」");
  expect(hint).not.toContain("「设置 → Agent 协作」");
});

it("the printed path can be followed step by step in the settings dialog", async () => {
  const hint = mailBarHint();
  const path = hint.match(/「(设置 → [^」]+)」/)?.[1];
  expect(path, `no settings path in: ${hint}`).toBeTruthy();
  const [root, tab, section] = path!.split(" → ");
  expect(root).toBe("设置");

  render(<SettingsModal settings={defaultSettings()} onChange={vi.fn()} onClose={vi.fn()}/>);
  const dialog = screen.getByRole("dialog");
  // Step 1: a settings tab with exactly that name exists.
  const trigger = within(dialog).getByRole("tab", { name: tab });
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  // Step 2: inside it, a collapsed section with exactly that title holds the per-session mailbox settings.
  const summary = await within(dialog).findByText(section, { selector: "summary" });
  const details = summary.closest("details")!;
  fireEvent.click(summary);
  details.open = true;
  expect(details.textContent).toMatch(/邮箱/);
  expect(within(dialog).getByRole("tabpanel").contains(details)).toBe(true);
});

it("leaves no user-facing pointer to the retired 「设置 → Agent 协作」 location", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const files = execFileSync("git", ["ls-files", "--", "README*.md", "docs", "apps/desktop/src"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(file => /\.(md|tsx?|rs)$/.test(file));
  expect(files.length).toBeGreaterThan(10);
  const stale = files.filter(file => /(设置|Settings)\s*(→|->)\s*Agent/.test(readFileSync(path.join(root, file), "utf8")));
  expect(stale).toEqual([]);
});
