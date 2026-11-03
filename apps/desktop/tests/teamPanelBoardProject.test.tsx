import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import TeamDynamics from "../src/components/TeamDynamics";
import { briefKey, parseAgentSessions, type LiveSessions } from "../src/lib/agentSessions";
import { memberDoingTaskFromIndex } from "../src/lib/teamPanelStatus";
import { emptyProfile } from "../src/lib/collaboration";
import type { TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

const server: ServerEntry = { id: "s", name: "Server", host: "example.test", port: 22, username: "dev", authMethod: "password" };
const worker = (name: string, project: string, boardProject?: string): TeamMember => ({
  project, boardProject, email: `${name}@example.test`, role: "worker", host: server.host, port: 22, username: "dev",
  workdir: "/repo", tmux: { id: `$${name}`, created: 1, name: `worker-${name}` },
});
const liveFor = (member: TeamMember, taskProject: string, code: string): LiveSessions => ({
  snapshot: parseAgentSessions({ sessions: [], now: 200, last_collected_at: 100 }),
  tasks: [{ project: taskProject, code, title: "Card", status_key: "doing", assignee: nameFrom(member), updated_at: "" }],
  taskProjects: [taskProject],
  briefs: { [briefKey(taskProject, code)]: { code, title: "Card", brief: "" } },
  statusNames: {},
  offline: false,
  error: "",
});
function nameFrom(member: TeamMember) {
  return member.email.split("@")[0];
}
const props = (members: TeamMember[], live: LiveSessions) => ({
  sessionId: "ssh",
  profile: { ...emptyProfile(), project: members[0]?.project ?? "demo" },
  navigation: { server, servers: [server], onOpen: vi.fn() },
  members,
  live,
  serviceLive: Object.fromEntries(members.map(m => [m.email, { match: "exact", state: "idle", stale: false }])),
  onUpdated: vi.fn(),
});

it("T97 shows a doing card when team roster and board project slugs differ", () => {
  const member = worker("demo-worker", "team-alpha", "board-alpha");
  const live = liveFor(member, "board-alpha", "T97");
  render(<TeamDynamics {...props([member], live)} />);
  expect(screen.getByRole("button", { name: /T97/ })).toBeTruthy();
  expect(memberDoingTaskFromIndex(member, live)).toEqual({ project: "board-alpha", code: "T97" });
});

it("T97 without boardProject keeps same-project behavior", () => {
  const member = worker("demo-worker", "demo");
  const live = liveFor(member, "demo", "T13");
  render(<TeamDynamics {...props([member], live)} />);
  expect(screen.getByRole("button", { name: /T13/ })).toBeTruthy();
  expect(memberDoingTaskFromIndex(member, live)).toEqual({ project: "demo", code: "T13" });
});

it("T97 without mapping misses cards on the board project slug", () => {
  const member = worker("demo-worker", "team-alpha");
  const live = liveFor({ ...member, boardProject: undefined }, "board-alpha", "T97");
  render(<TeamDynamics {...props([member], live)} />);
  expect(screen.queryByRole("button", { name: /T97/ })).toBeNull();
  expect(memberDoingTaskFromIndex(member, live)).toBeUndefined();
});
