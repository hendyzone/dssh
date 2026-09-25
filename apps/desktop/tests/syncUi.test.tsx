import { expect, it, vi } from "vitest";
import { collectSyncUi, restoreSyncUi } from "../src/lib/syncUi";

it("syncs model provider profiles and stops collectors on restore without local-storage secrets", () => {
  const config=JSON.stringify({endpoint:"https://api.deepseek.com/chat/completions",model:"example"});
  localStorage.setItem("dssh.team-ai.v1",config);
  localStorage.setItem("dssh.team-ai.profiles.v1",JSON.stringify({deepseek:JSON.parse(config)}));
  const backup=collectSyncUi();
  expect(backup["dssh.team-ai.v1"]).toBe(config);
  expect(JSON.parse(backup["dssh.team-ai.profiles.v1"]).deepseek.model).toBe("example");
  const listener=vi.fn();
  window.addEventListener("dssh-team-ai-config",listener);
  restoreSyncUi(backup);
  expect(listener).toHaveBeenCalledOnce();
  expect(Object.keys(backup).some(k=>/api.?key|auto/i.test(k))).toBe(false);
  window.removeEventListener("dssh-team-ai-config",listener);
});

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

it("includes team bindings and restores them with an immediate refresh notification", () => {
  const profiles=JSON.stringify({'["source","$1",123,"/repo"]':{project:"demo"}});
  localStorage.setItem("dssh.collaboration.v2",profiles);
  localStorage.setItem("dssh.team-connections.v1",JSON.stringify({member:"source"}));
  const values=collectSyncUi();
  expect(values["dssh.collaboration.v2"]).toBe(profiles);
  expect(values["dssh.team-connections.v1"]).toBe('{"member":"source"}');
  const listener=vi.fn();
  window.addEventListener("dssh-collaboration-changed",listener);
  restoreSyncUi({"dssh.collaboration.v2":"{}","dssh.team-connections.v1":"{}"});
  expect(localStorage.getItem("dssh.collaboration.v2")).toBe("{}");
  expect(listener).toHaveBeenCalledOnce();
  window.removeEventListener("dssh-collaboration-changed",listener);
});
