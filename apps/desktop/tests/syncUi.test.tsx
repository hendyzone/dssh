import { expect, it, vi } from "vitest";
import { collectSyncUi, restoreSyncUi } from "../src/lib/syncUi";

it("exports only the supported UI preferences, never arbitrary local storage", () => {
  localStorage.setItem("unrelated-secret", "synthetic-secret");
  localStorage.setItem("dssh.sync.repository", "example/repo");
  localStorage.setItem("dssh.panel-side.tmux", "left");
  const prefs = collectSyncUi();
  expect(prefs["dssh.panel-side.tmux"]).toBe("left");
  expect(JSON.parse(prefs["dssh.sidebar.tree-layout"])).toEqual({
    folders: [],
    order: {},
  });
  expect(prefs).not.toHaveProperty("unrelated-secret");
  expect(prefs).not.toHaveProperty("dssh.sync.repository");
});
it("restores layout preferences and notifies mounted docks", () => {
  const listener = vi.fn();
  window.addEventListener("dssh-panel-position", listener);
  restoreSyncUi({
    "dssh.panel-side.tmux": "left",
    "dssh.sidebar.width": "320",
  });
  expect(localStorage.getItem("dssh.sidebar.width")).toBe("320");
  expect(listener).toHaveBeenCalledTimes(1);
  window.removeEventListener("dssh-panel-position", listener);
});
it("rejects an unknown backup key before changing local state", () => {
  localStorage.setItem("dssh.sidebar.width", "264");
  expect(() =>
    restoreSyncUi({ "dssh.sidebar.width": "500", untrusted: "value" }),
  ).toThrow();
  expect(localStorage.getItem("dssh.sidebar.width")).toBe("264");
});
