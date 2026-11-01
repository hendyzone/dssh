import { describe, expect, it } from "vitest";
import { MACHINE_SEGMENT, memberBox, memberDisplay, memberMachine, memberModel, memberTool, withoutMachine } from "../src/lib/memberDisplay";
import { memberKey } from "../src/lib/teamMembers";
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
  it("falls back to the stable member id when there is no mailbox, tmux name, or roster name", () => {
    const bare = member({ email: "", id: "member-1", tmux: { id: "$1", created: 1, name: " " } });
    expect(memberBox(bare)).toBe("member-1");
    expect(memberDisplay(bare).title).toBe("member-1");
  });
  it("prefers tmux session name over member id when the mailbox is empty", () => {
    const tmux = { id: "$3", created: 2, name: "smart-table-lead" };
    expect(memberBox(member({ email: "", id: "member-31ef", tmux }))).toBe("smart-table-lead");
    expect(memberDisplay(member({ email: "", id: "member-31ef", tmux })).title).toBe("smart-table-lead");
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
  it("parses the new 'tool · model' role format", () => {
    expect(memberModel(member({ role: "dsh · deepseek-v4-flash" }))).toBe("deepseek-v4-flash");
    expect(memberModel(member({ role: "codex · GPT-6-Astra medium" }))).toBe("GPT-6-Astra medium");
    expect(memberModel(member({ role: "worker（dsh，deepseek-v4-flash）" }))).toBe("deepseek-v4-flash");
    expect(memberModel(member({ role: "dsh · deepseek-v4-flash" }), { model: "gpt-6-live" })).toBe("gpt-6-live");
    expect(memberModel(member({ role: "Lead" }))).toBeUndefined();
    // 首段不是工具时不能误吞；仍走旧括号解析或 undefined。
    expect(memberModel(member({ role: "Lead · 2026-Q4" }))).toBeUndefined();
    expect(memberModel(member({ role: "负责人（dsh，deepseek-v4-flash）" }))).toBe("deepseek-v4-flash");
  });
  it("never renders the tool twice when the model equals the tool", () => {
    const dsh = { email: "amail-cw3-dsh@example.invalid" };
    expect(memberDisplay(member({ ...dsh, role: "dsh · dsh" })).subtitle).toBe("dsh");
    expect(memberDisplay(member({ ...dsh, role: "dsh · deepseek-v4-flash" })).subtitle).toBe("dsh · deepseek-v4-flash");
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

// dssh/T86: Leads move between machines, so their title never carries the `-cwN` machine segment.
describe("Lead title without the machine segment", () => {
  const noTmux = { id: "", created: 0, name: "" };
  it("prefers the Lead's tmux session name over the mailbox", () => {
    const lead = member({ email: "nst-vision-cw2-lead@example.invalid", role: "Lead", tmux: { id: "$7", created: 7, name: "nst-vision-lead" } });
    expect(memberBox(lead)).toBe("nst-vision-lead");
    expect(memberDisplay(lead).title).toBe("nst-vision-lead");
    // Recognised by the shared isLeadMember rule alone (mailbox ends in -lead), not only by role.
    const byMailbox = member({ email: "dcollab-cw1-lead@example.invalid", role: "worker", tmux: { id: "$8", created: 8, name: "dcollab-lead" } });
    expect(memberDisplay(byMailbox).title).toBe("dcollab-lead");
  });
  it("falls back to the mailbox local part without the machine segment when there is no tmux", () => {
    expect(memberDisplay(member({ email: "dcollab-cw1-lead@example.invalid", role: "Lead", tmux: noTmux })).title).toBe("dcollab-lead");
    expect(memberDisplay(member({ email: "nst-vision-cw2-lead@example.invalid", role: "worker", tmux: noTmux })).title).toBe("nst-vision-lead");
    // A tmux name that still carries a machine segment is cleaned the same way.
    expect(memberDisplay(member({ email: "", role: "Lead", tmux: { id: "$9", created: 9, name: "alpha-cw3-lead" } })).title).toBe("alpha-lead");
  });
  it("keeps worker titles exactly as before", () => {
    expect(memberDisplay(member()).title).toBe("alpha-cw1-codex");
    expect(memberDisplay(member({ email: "amail-cw3-dsh@example.invalid", tmux: { id: "$4", created: 4, name: "worker-amail-cw3-dsh" } })).title).toBe("amail-cw3-dsh");
    expect(memberDisplay(member({ email: "", id: "member-9", tmux: { id: "$5", created: 5, name: "worker-alpha-cw2-pi" } })).title).toBe("worker-alpha-cw2-pi");
  });
  it("lets the caller's Lead knowledge override the roster-only check", () => {
    const selfLead = member({ email: "alpha-cw2-claude@example.invalid", role: "协调", tmux: { id: "$1", created: 1, name: "alpha-coordinator" } });
    expect(memberDisplay(selfLead).title).toBe("alpha-cw2-claude");
    expect(memberDisplay(selfLead, undefined, {}, true).title).toBe("alpha-coordinator");
    expect(memberDisplay(member({ email: "dcollab-cw1-lead@example.invalid", role: "Lead" }), undefined, {}, false).title).toBe("dcollab-cw1-lead");
  });
  it("does not change the mailbox, member key or tool inference of a Lead", () => {
    const lead = member({ email: "nst-vision-cw2-lead@example.invalid", role: "Lead · claude", tmux: { id: "$7", created: 7, name: "nst-vision-lead" } });
    expect(memberKey(lead)).toBe("nst-vision-cw2-lead@example.invalid");
    expect(lead.email).toBe("nst-vision-cw2-lead@example.invalid");
    expect(memberTool(member({ email: "alpha-cw1-claude-lead@example.invalid", role: "Lead", tmux: { id: "$7", created: 7, name: "alpha-lead" } }))).toBe("claude");
  });
  it.each([
    ["nst-vision-cw2-lead", "nst-vision-lead"],
    ["dcollab-cw1-lead", "dcollab-lead"],
    ["leadkit-cw3-lead", "leadkit-lead"],
    ["alpha-cw12-lead", "alpha-lead"],
    ["alpha-CW2-lead", "alpha-lead"],
    ["alpha-lead-cw1", "alpha-lead"],
    ["alpha-cw1-cw2-lead", "alpha-lead"],
    ["nst-vision-lead", "nst-vision-lead"],
    ["alpha-cwx-lead", "alpha-cwx-lead"],
    ["alpha-cw1x-lead", "alpha-cw1x-lead"],
    ["alphacw1-lead", "alphacw1-lead"],
    ["cw1", "cw1"],
  ])("machine segment rule %s → %s", (input, expected) => {
    expect(MACHINE_SEGMENT.source).toBe("-cw\\d+(?=-|$)");
    expect(withoutMachine(input)).toBe(expected);
  });
});
