import { expect, it } from "vitest";
import { loadWorkspace, saveWorkspace, restoreDirectoryCommand, type Workspace } from "../src/lib/workspaceRestore";
import type { ServerEntry } from "../src/types";
import { LOCAL_SHELL, quoteLocalPath } from "../src/lib/localShell";

it("restores local split panes without an SSH server or credentials", () => {
  saveWorkspace({ tabs: [{ id: "local-tab", activePane: 1, splitDir: "row", panes: [
    { id: "local-1", server: LOCAL_SHELL }, { id: "local-2", server: LOCAL_SHELL },
  ] }], activeTabId: "local-tab", groups: [], cwds: {} });
  const restored = loadWorkspace([]);
  expect(restored.tabs[0].panes.map(p => p.server)).toEqual([LOCAL_SHELL, LOCAL_SHELL]);
  expect(restored.tabs[0].activePane).toBe(1);
  expect(quoteLocalPath("/tmp/a'b $(whoami)", false)).toBe("'/tmp/a'\"'\"'b $(whoami)'");
  expect(quoteLocalPath("C:\\a'b $(whoami)", true)).toBe("'C:\\a''b $(whoami)'");
});

const server: ServerEntry = { id: "server", name: "Host", host: "example.com", port: 22, username: "root", authMethod: "publicKey", keyPath: "secret-key-path" };
const fixture = (): Workspace => ({
  tabs: [{ id: "tab", customTitle: "工作", groupId: "group", splitDir: "column", activePane: 1,
    panes: [{ id: "shell", server }, { id: "tmux", server, tmux: { id: "$3", created: 456, name: "agent" }, tmuxWorkdir: "/repo" }] }],
  activeTabId: "tab", groups: [{ id: "group", name: "开发", color: "#7aa2f7", collapsed: false }],
  cwds: { shell: "/repo/中文 folder", tmux: "/repo" },
});

it("round trips layout, focus, groups, directories and tmux incarnation using current credentials", () => {
  const workspace = fixture();
  saveWorkspace(workspace);
  expect(localStorage.getItem("dssh.workspace.v1")).not.toContain("secret-key-path");
  const current = { ...server, keyPath: "new-key" };
  const restored = loadWorkspace([current]);
  expect(restored).toEqual({ ...workspace, tabs: [{ ...workspace.tabs[0], panes: workspace.tabs[0].panes.map(p => ({ ...p, server: current, restoreCwd: workspace.cwds[p.id] })) }] });
});

it("skips deleted or retargeted servers without silently creating a different connection", () => {
  saveWorkspace(fixture());
  expect(loadWorkspace([]).tabs).toEqual([]);
  expect(loadWorkspace([{ ...server, host: "other.example.com" }]).tabs).toEqual([]);
  expect(loadWorkspace([{ ...server, username: "other" }]).tabs).toEqual([]);
});

it("rejects malformed tmux identity while retaining a valid sibling and fixing focus", () => {
  saveWorkspace(fixture());
  const stored = JSON.parse(localStorage.getItem("dssh.workspace.v1")!);
  stored.tabs[0].panes[1].tmux.created = "456";
  localStorage.setItem("dssh.workspace.v1", JSON.stringify(stored));
  const restored = loadWorkspace([server]);
  expect(restored.tabs[0].panes).toHaveLength(1);
  expect(restored.tabs[0].activePane).toBe(0);
  expect(restored.tabs[0].splitDir).toBeUndefined();
});

it("preserves corrupt storage for the caller to report instead of treating it as an empty workspace", () => {
  localStorage.setItem("dssh.workspace.v1", "broken");
  expect(() => loadWorkspace([server])).toThrow();
  expect(localStorage.getItem("dssh.workspace.v1")).toBe("broken");
});

it("persists closing every tab so deliberately closed work does not return", () => {
  saveWorkspace(fixture());
  saveWorkspace({ tabs: [], activeTabId: null, groups: [], cwds: {} });
  expect(loadWorkspace([server]).tabs).toEqual([]);
});

it("quotes shell metacharacters and rejects control characters in restored paths", () => {
  expect(restoreDirectoryCommand("/tmp/a'b $(touch nope)`cmd`"))
    .toContain("cd -- '/tmp/a'\"'\"'b $(touch nope)`cmd`'");
  expect(restoreDirectoryCommand("/tmp/a\nwhoami")).toBe("");
  expect(restoreDirectoryCommand("relative")).toBe("");
});
