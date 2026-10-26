import { describe, expect, it } from "vitest";
import { memberBox, memberDisplay, memberMachine, memberModel, memberTool } from "../src/lib/memberDisplay";
import type { TeamMember } from "../src/lib/teamMembers";

const member = (over: Partial<TeamMember> = {}): TeamMember => ({
  project: "alpha", email: "alpha-cw1-codex@example.invalid", role: "worker（Codex，gpt-6）",
  host: "host-a", port: 22, username: "dev", workdir: "/repo",
  tmux: { id: "$2", created: 1, name: "worker-alpha-cw1-codex" }, ...over,
});

describe("memberDisplay", () => {
  it("uses the mailbox local part as the title and never the free-text role", () => {
    expect(memberBox(member())).toBe("alpha-cw1-codex");
    expect(memberDisplay(member()).title).toBe("alpha-cw1-codex");
    expect(memberDisplay(member({ role: "worker（DeepSeek Harness，deepseek-v4-flash）" })).title).toBe("alpha-cw1-codex");
  });
  it("falls back to the stable member id when there is no mailbox", () => {
    expect(memberBox(member({ email: "", id: "member-1" }))).toBe("member-1");
    expect(memberDisplay(member({ email: "", id: "member-1" })).title).toBe("member-1");
  });
  it("infers the tool from the live child or the box suffix", () => {
    expect(memberTool(member())).toBe("codex");
    expect(memberTool(member({ email: "amail-cw3-dsh@example.invalid" }))).toBe("dsh");
    expect(memberTool(member({ email: "box@example.invalid" }), { child: "claude" })).toBe("claude");
    expect(memberTool(member({ email: "box@example.invalid", role: "worker" }))).toBeUndefined();
  });
  it("prefers live.model and otherwise parses the model from the role parenthetical", () => {
    expect(memberModel(member(), { model: "gpt-6-live" })).toBe("gpt-6-live");
    expect(memberModel(member())).toBe("gpt-6");
    expect(memberModel(member({ role: "worker（DeepSeek Harness，deepseek-v4-flash）" }))).toBe("deepseek-v4-flash");
    expect(memberModel(member({ role: "worker" }))).toBeUndefined();
  });
  it("shows a machine name but never an IP address", () => {
    expect(memberMachine(member(), { machine: "host-a" })).toBe("host-a");
    expect(memberMachine(member({ host: "host-b" }), undefined, { "host-b": { online: true } })).toBe("host-b");
    expect(memberMachine(member({ host: "host-c" }))).toBe("host-c");
    expect(memberMachine(member({ host: "203.0.113.5" }))).toBeUndefined();
    expect(memberMachine(member({ host: "198.51.100.7" }), { machine: "host-d" })).toBe("host-d");
  });
  it("builds 'tool · model' and only shows what it knows", () => {
    expect(memberDisplay(member(), { machine: "host-a" })).toMatchObject({
      title: "alpha-cw1-codex", subtitle: "codex · gpt-6", machine: "host-a", role: "worker（Codex，gpt-6）",
    });
    expect(memberDisplay(member({ role: "worker" })).subtitle).toBe("codex");
    expect(memberDisplay(member({ role: "worker", email: "box@example.invalid" })).subtitle).toBe("");
  });
});
