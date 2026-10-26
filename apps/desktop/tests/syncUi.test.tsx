import { expect, it, vi } from "vitest";
import { collectSyncUi, restoreSyncUi } from "../src/lib/syncUi";
import { defaultLookupSettings, loadLookupSettings, TASK_LOOKUP_KEY, TASK_LOOKUP_EVENT } from "../src/lib/taskLookup";

it("round-trips every task lookup preference and notifies mounted consumers", () => {
  const settings = { boardUrl:"http://board.test:8091/", terminalLinks:false, lockedProject:"demo",
    overrides:{"server:srv":"demo","tmux:srv:lead:one":"docs"} };
  localStorage.setItem(TASK_LOOKUP_KEY, JSON.stringify(settings));
  const backup = collectSyncUi();
  localStorage.removeItem(TASK_LOOKUP_KEY);
  const listener = vi.fn();
  window.addEventListener(TASK_LOOKUP_EVENT, listener);
  restoreSyncUi(backup);
  expect(loadLookupSettings()).toEqual(settings);
  expect(listener).toHaveBeenCalledOnce();
  window.removeEventListener(TASK_LOOKUP_EVENT, listener);
});

it("exports valid task defaults and preserves local settings when older backups omit them", () => {
  expect(JSON.parse(collectSyncUi()[TASK_LOOKUP_KEY])).toEqual(defaultLookupSettings());
  const settings = {...defaultLookupSettings(),boardUrl:"https://board.test"};
  localStorage.setItem(TASK_LOOKUP_KEY,JSON.stringify(settings));
  restoreSyncUi({"dssh.sidebar.width":"320"});
  expect(loadLookupSettings()).toEqual(settings);
});

it("omits retired local AI settings and ignores them in older bundles", () => {
  localStorage.setItem("dssh.team-ai.v1","old-local-value");
  localStorage.setItem("dssh.team-ai.profiles.v1","old-local-profiles");
  const backup=collectSyncUi();
  expect(backup).not.toHaveProperty("dssh.team-ai.v1");
  expect(backup).not.toHaveProperty("dssh.team-ai.profiles.v1");
  restoreSyncUi({"dssh.team-ai.v1":"invalid-json", "dssh.team-ai.profiles.v1":"ignored", "dssh.sidebar.width":"320"});
  expect(localStorage.getItem("dssh.team-ai.v1")).toBe("old-local-value");
  expect(localStorage.getItem("dssh.team-ai.profiles.v1")).toBe("old-local-profiles");
  expect(localStorage.getItem("dssh.sidebar.width")).toBe("320");
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
