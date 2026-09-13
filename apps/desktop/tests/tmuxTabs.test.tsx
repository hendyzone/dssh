import { expect, test } from "vitest";
import { findTmuxTab } from "../src/lib/tmuxTabs";
import { defaultSettings, loadSettings, saveSettings } from "../src/store";
import type { ServerEntry, TabInfo } from "../src/types";

const server: ServerEntry = { id: "server", name: "server", host: "example.com", port: 22, username: "demo", authMethod: "password" };
const remote = { id: "$0", name: "work", created: 123 };
const tab: TabInfo = { id: "tab", activePane: 0, panes: [
  { id: "shell", server },
  { id: "tmux", server, tmux: remote },
] };

test("finds a matching split pane and prefers the active tab when duplicates exist", () => {
  expect(findTmuxTab([tab], server, { ...remote, name: "renamed" })).toEqual({ tab, paneIndex: 1 });
  const second = { ...tab, id: "second" };
  expect(findTmuxTab([tab, second], server, remote, "second")?.tab.id).toBe("second");
  expect(findTmuxTab([tab], { ...server, id: "another-saved-entry" }, remote)?.tab.id).toBe("tab");
});

test("does not reuse another remote user, host, port or recreated tmux identity", () => {
  for (const other of [{ ...server, username: "root" }, { ...server, host: "other" }, { ...server, port: 2222 }]) {
    expect(findTmuxTab([tab], other, remote)).toBeNull();
  }
  expect(findTmuxTab([tab], server, { ...remote, created: 456 })).toBeNull();
  expect(findTmuxTab([tab], server, { ...remote, id: "$1" })).toBeNull();
});

test("tab reuse defaults on for old settings and remembers disabling it", () => {
  localStorage.setItem("dssh.settings", JSON.stringify({ fontSize: 16 }));
  expect(defaultSettings().reuseTmuxTabs).toBe(true);
  expect(loadSettings().reuseTmuxTabs).toBe(true);
  saveSettings({ ...defaultSettings(), reuseTmuxTabs: false });
  expect(loadSettings().reuseTmuxTabs).toBe(false);
  localStorage.removeItem("dssh.settings");
});
