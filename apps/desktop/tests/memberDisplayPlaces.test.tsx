import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TeamDynamics from "../src/components/TeamDynamics";
import TeamMembers from "../src/components/TeamMembers";
import { buildOfficeSnapshot, officeTeamSources } from "../src/lib/teamOffice";
import { emptyProfile, collaborationKey } from "../src/lib/collaboration";
import { memberDisplay } from "../src/lib/memberDisplay";
import type { TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

const serviceFixture = vi.hoisted(() => ({ current: {} as any }));
vi.mock("../src/lib/teamService", () => ({ useTeamService: () => serviceFixture.current, refreshTeamService: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const server: ServerEntry = { id: "s", name: "Example", host: "host-a", port: 22, username: "dev", authMethod: "password" };
const profile = { ...emptyProfile(), enabled: true, membersEnabled: true, project: "alpha", workdir: "/lead", tmuxId: "$1", tmuxCreated: 100, tmuxName: "lead" };
const member: TeamMember = {
  project: "alpha", email: "alpha-cw1-codex@example.invalid", role: "worker（Codex，gpt-6）",
  host: "203.0.113.5", port: 22, username: "dev", workdir: "/repo",
  tmux: { id: "$2", created: 123, name: "worker-alpha-cw1-codex" },
};
const navigation = { server, servers: [server], onOpen: vi.fn() };
const onlineRoster = () => {
  serviceFixture.current = {
    url: "https://team.example.invalid", projects: ["alpha"],
    status: { state: "online", token_configured: true },
    snapshots: { alpha: { project: "alpha", identity: "alpha", seq: 1, members: [member], ai: {}, machines: {},
      live: { "alpha-cw1-codex@example.invalid": { key: "alpha-cw1-codex@example.invalid", match: "exact", state: "idle" } },
      receivedAt: Date.now(), offline: false, status: "online" } },
  };
};
const dynamics = () => render(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={[member]} onUpdated={async () => {}} />);

it("shows the same mailbox-first name in the room, the dynamic list and the member panel", async () => {
  const expected = memberDisplay(member).title;
  expect(expected).toBe("alpha-cw1-codex");
  const sources = officeTeamSources({ [collaborationKey(server.id, profile)]: profile }, [server], []);
  const office = buildOfficeSnapshot(sources, { [sources[0].id]: { availability: "ready", notice: "", members: [member], machines: {} } },
    { servers: [server], sessions: [], themeId: "one-light", animationEnabled: false });
  expect(office.projects[0].sources[0].members[0].name).toBe(expected);

  const list = dynamics();
  expect(screen.getByTitle("alpha-cw1-codex · worker-alpha-cw1-codex").firstChild?.textContent).toBe(expected);
  list.unmount();

  onlineRoster();
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={navigation} />);
  expect((await screen.findAllByText("alpha-cw1-codex")).length).toBeGreaterThan(0);
});

it("never renders a raw IP address for the member", () => {
  const { container } = dynamics();
  expect(container.textContent).not.toContain("203.0.113.5");
});

it("keeps the role in the details instead of using it as the title", async () => {
  onlineRoster();
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={navigation} />);
  const row = (await screen.findByRole("button", { name: "打开 · alpha-cw1-codex" })).closest("details")!;
  row.open = true;
  fireEvent(row, new Event("toggle"));
  await waitFor(() => expect(row.open).toBe(true));
  expect(await screen.findByText(/角色：worker（Codex，gpt-6）/)).toBeTruthy();
});
