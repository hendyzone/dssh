import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dssh/T85 (+T86): office hints tell users where in settings to fix something (mailbox, team service
// token). Follow each printed path through the real settings dialog, so a renamed tab or section turns this red.
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

const tokenExpired: OfficeSnapshot = { ...unconfigured, service: { state: "unauthorized", tokenConfigured: true } };

beforeEach(() => { localStorage.clear(); });

/** Every office hint that sends the user into settings, the path it must print, and what that place must hold. */
const hints = [
  { name: "mail bar (no mailbox bound)", snapshot: unconfigured, text: /邮件动态未配置/,
    path: "「设置 → 团队 → 高级：按会话的 Agent 协作（邮件）」", holds: (place: HTMLElement) => expect(place.textContent).toMatch(/邮箱/) },
  // dssh/T86 (folded in from T85 review): the expired-token note named a 「设置 → 团队服务」 tab that does not exist.
  { name: "team service token expired", snapshot: tokenExpired, text: /团队服务令牌已失效/,
    path: "「设置 → 团队 → 团队服务」", holds: (place: HTMLElement) => expect(within(place).getByLabelText("团队服务令牌")).toBeTruthy() },
];

function officeHint(snapshot: OfficeSnapshot, text: RegExp): string {
  const view = render(<TeamOffice snapshot={snapshot}/>);
  const hint = screen.getByText(text).textContent ?? "";
  view.unmount();
  return hint;
}

it.each(hints)("$name: prints the real settings location", ({ snapshot, text, path }) => {
  const hint = officeHint(snapshot, text);
  expect(hint).toContain(path);
  expect(hint).not.toMatch(/「设置 → (Agent 协作|团队服务)」/);
});

it.each(hints)("$name: the printed path can be followed step by step in the settings dialog", async ({ snapshot, text, holds }) => {
  const hint = officeHint(snapshot, text);
  const printed = hint.match(/「(设置 → [^」]+)」/)?.[1];
  expect(printed, `no settings path in: ${hint}`).toBeTruthy();
  const [root, tab, ...sections] = printed!.split(" → ");
  expect(root).toBe("设置");
  expect(sections.length).toBeGreaterThan(0);

  render(<SettingsModal settings={defaultSettings()} onChange={vi.fn()} onClose={vi.fn()}/>);
  const dialog = screen.getByRole("dialog");
  // Step 1: a settings tab with exactly that name exists.
  const trigger = within(dialog).getByRole("tab", { name: tab });
  fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  const panel = await within(dialog).findByRole("tabpanel");
  // Next steps: inside that tab, a collapsed section (summary) or a group (legend) titled exactly so.
  let place: HTMLElement = panel;
  for (const title of sections) {
    const heading = within(place).getAllByText(title, { selector: "summary, legend" })[0];
    expect(heading, `no section 「${title}」 under 「${tab}」`).toBeTruthy();
    const details = heading.closest("details");
    if (heading.tagName === "SUMMARY" && details) { fireEvent.click(heading); details.open = true; }
    place = (heading.tagName === "SUMMARY" ? details : heading.closest("fieldset")) as HTMLElement;
  }
  expect(panel.contains(place)).toBe(true);
  holds(place);
});

it("leaves no user-facing pointer to retired settings locations (「设置 → Agent 协作」, 「设置 → 团队服务」)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const files = execFileSync("git", ["ls-files", "--", "README*.md", "docs", "apps/desktop/src"], { cwd: root, encoding: "utf8" })
    .split("\n").filter(file => /\.(md|tsx?|rs)$/.test(file));
  expect(files.length).toBeGreaterThan(10);
  const retired = [/(设置|Settings)\s*(→|->)\s*Agent/, /设置\s*(→|->)\s*团队服务/];
  const stale = files.filter(file => retired.some(pattern => pattern.test(readFileSync(path.join(root, file), "utf8"))));
  expect(stale).toEqual([]);
});
