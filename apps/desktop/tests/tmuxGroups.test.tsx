import { expect, test } from "vitest";
import {
  LEAD_GROUP,
  WORKER_GROUP,
  classifyTmuxSession,
  compareTmuxGroups,
  leadProject,
  workerProject,
} from "../src/lib/tmuxGroups";

test("parses the project of worker-<project>-<machine>-<tool> sessions", () => {
  expect(classifyTmuxSession("worker-datrix-cw1-codex")).toEqual({ group: WORKER_GROUP, subgroup: "datrix", display: "cw1-codex" });
  expect(classifyTmuxSession("worker-datrix-cw1b-pi")).toEqual({ group: WORKER_GROUP, subgroup: "datrix", display: "cw1b-pi" });
  expect(classifyTmuxSession("worker-datrix-cw3b-cursor")).toEqual({ group: WORKER_GROUP, subgroup: "datrix", display: "cw3b-cursor" });
});

test("keeps multi-segment project names such as smart-table", () => {
  expect(classifyTmuxSession("worker-smart-table-cw1c-pi")).toEqual({ group: WORKER_GROUP, subgroup: "smart-table", display: "cw1c-pi" });
  expect(classifyTmuxSession("worker-smart-table-devc-pi")).toEqual({ group: WORKER_GROUP, subgroup: "smart-table", display: "devc-pi" });
  expect(workerProject("worker-smart-table-dev-codex")).toBe("smart-table");
});

test("drops the tool and role segments when there is no machine segment", () => {
  expect(classifyTmuxSession("worker-smart-table-camera-claude")).toEqual({ group: WORKER_GROUP, subgroup: "smart-table", display: "camera-claude" });
  expect(workerProject("worker-dnote-claude")).toBe("dnote");
});

test("legacy worker names without the worker- prefix still get a project but keep their full label", () => {
  expect(classifyTmuxSession("smart-table-cw1c-pi")).toEqual({ group: WORKER_GROUP, subgroup: "smart-table", display: "smart-table-cw1c-pi" });
  expect(classifyTmuxSession("agentdock-cw1-codex")).toEqual({ group: WORKER_GROUP, subgroup: "agentdock", display: "agentdock-cw1-codex" });
  expect(workerProject("project-worker-2")).toBe("project");
  expect(workerProject("worker-cw1-codex")).toBe("");
});

test("classifies *-lead and lead-* sessions as Leads, labelled by project slug", () => {
  expect(classifyTmuxSession("smart-table-lead")).toEqual({ group: LEAD_GROUP, subgroup: "", display: "smart-table" });
  expect(classifyTmuxSession("datrix-lead")).toEqual({ group: LEAD_GROUP, subgroup: "", display: "datrix" });
  expect(classifyTmuxSession("dnotes-lead")).toEqual({ group: LEAD_GROUP, subgroup: "", display: "dnotes" });
  expect(classifyTmuxSession("example-project-lead")).toEqual({ group: LEAD_GROUP, subgroup: "", display: "example-project" });
  expect(classifyTmuxSession("lead-datrix")).toEqual({ group: LEAD_GROUP, subgroup: "", display: "datrix" });
  expect(classifyTmuxSession("nst-lead").display).toBe("nst");
});

test("a Lead's project slug matches its workers' sub-folder", () => {
  const pairs: [string, string][] = [
    ["smart-table-lead", "worker-smart-table-cw1c-pi"],
    ["smart-table-lead", "worker-smart-table-camera-claude"],
    ["smart-table-lead", "worker-smart-table-devc-pi"],
    ["datrix-lead", "worker-datrix-cw1-codex"],
    ["datrix-lead", "worker-datrix-cw3b-cursor"],
    ["dnotes-lead", "worker-dnotes-cw1-claude"],
    ["example-project-lead", "worker-example-project-dev-codex"],
  ];
  for (const [lead, worker] of pairs) {
    expect(leadProject(lead)).toBe(classifyTmuxSession(worker).subgroup);
  }
  expect(classifyTmuxSession("leader").group).toBe("");
  expect(classifyTmuxSession("misleading-notes").group).toBe("");
});

test("manual groups override automatic Leads and Workers", () => {
  expect(classifyTmuxSession("worker-datrix-cw1-codex", "手动分组")).toEqual({ group: "手动分组", subgroup: "", display: "worker-datrix-cw1-codex" });
  expect(classifyTmuxSession("nst-lead", "项目甲")).toEqual({ group: "项目甲", subgroup: "", display: "nst-lead" });
  // A session manually filed under Workers is still split by project.
  expect(classifyTmuxSession("worker-datrix-cw1-codex", WORKER_GROUP)).toEqual({ group: WORKER_GROUP, subgroup: "datrix", display: "cw1-codex" });
});

test("non-worker names stay ungrouped", () => {
  expect(classifyTmuxSession("work")).toEqual({ group: "", subgroup: "", display: "work" });
  expect(classifyTmuxSession("homework-notes").group).toBe("");
});

test("orders manual folders, then Leads before Workers, ungrouped last", () => {
  expect(["", WORKER_GROUP, "项目甲", LEAD_GROUP, "Alpha"].sort(compareTmuxGroups)).toEqual(["Alpha", "项目甲", LEAD_GROUP, WORKER_GROUP, ""]);
});
