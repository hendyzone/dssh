import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AdventurePanel from "../src/components/AdventurePanel";
import ToolRail from "../src/components/ToolRail";
import { teamAvatarShirt } from "../src/components/TeamMemberAvatar";
import type { TeamServiceState, TeamServiceProject } from "../src/lib/teamService";
import { memberKey, type TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

const server = (id: string): ServerEntry => ({id, name: id, host: `${id}.example.invalid`, port: 22, username: "demo", authMethod: "password"});
const servers = [server("east"), server("west")];
const member = (project: string, role: string, host = servers[0].host): TeamMember => ({project, email: `${project}-${role.startsWith("Lead") ? "lead-codex" : "worker"}@example.invalid`, role, host, port:22, username:"demo", workdir:`/work/${project}`, tmux:{id:"$1",created:1,name:role.startsWith("Lead") ? `${project}-lead` : project}});
function fixture(): TeamServiceState {
  const snapshots: Record<string, TeamServiceProject> = {};
  for (const [project, state, host] of [["alpha", "idle", servers[0].host], ["beta", "stuck", servers[1].host]] as const) {
    const lead = member(project, "Lead · codex", host);
    snapshots[project] = {project,seq:1,lseq:1,members:[member(project,"worker"),lead],ai:{},machines:{},receivedAt:Date.now(),offline:false,status:"online",identity:project,
      live:{[memberKey(lead)]:{key:memberKey(lead),state,match:"exact",detail:"",machine:project === "alpha" ? "East" : "West"}}};
  }
  return {url:"https://team.example.invalid/api/v1", projects:["alpha","beta"],status:{state:"online",token_configured:true},snapshots};
}
it("lists subscribed Leads only, prioritizes stuck, and opens the exact member and server", async () => {
  const service = fixture(), onOpen = vi.fn().mockResolvedValue(undefined);
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={onOpen} onClose={()=>{}}/>);
  expect(screen.getAllByRole("heading",{level:3}).map(x=>x.textContent)).toEqual(["beta","alpha"]);
  expect(screen.queryByText(/-worker/)).toBeNull();
  expect(within(screen.getByRole("region",{name:"beta"})).getByText("West")).toBeTruthy();
  expect(screen.getByRole("region",{name:"beta"}).querySelector(".adventure-meta-agent")?.textContent).toBe("beta-lead · codex");
  fireEvent.click(screen.getByRole("button",{name:"打开 Lead · beta · beta-lead"}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledWith(service.snapshots.beta.members[1],servers[1]));
});
it("keeps missing rosters, no Lead, unavailable connections and click errors local to their row", async () => {
  const service = fixture();
  service.projects.push("empty","broken","unmapped");
  service.snapshots.empty = {...service.snapshots.alpha, project:"empty",members:[member("empty","worker")]};
  service.snapshots.unmapped = {...service.snapshots.alpha,project:"unmapped",members:[member("unmapped","Lead","missing.example.invalid")]};
  const onOpen = vi.fn().mockRejectedValueOnce(new Error("连接失败")).mockResolvedValue(undefined);
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={onOpen} onClose={()=>{}}/>);
  expect(within(screen.getByRole("region",{name:"empty"})).getByText("未登记 Lead")).toBeTruthy();
  expect(within(screen.getByRole("region",{name:"broken"})).getByText("名单不可用")).toBeTruthy();
  expect((screen.getByRole("button",{name:/打开 Lead · unmapped/}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button",{name:/打开 Lead · beta/}));
  expect(await within(screen.getByRole("region",{name:"beta"})).findByRole("alert")).toHaveProperty("textContent","连接失败");
  fireEvent.click(screen.getByRole("button",{name:/打开 Lead · alpha/}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledTimes(2));
  expect(within(screen.getByRole("region",{name:"alpha"})).queryByRole("alert")).toBeNull();
});
it("updates order with live snapshots and does not show stale offline data as working", () => {
  const service = fixture();
  const view=render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  const alpha = service.snapshots.alpha, beta = service.snapshots.beta;
  alpha.live[memberKey(alpha.members[1])].state="waiting_input";
  beta.offline=true;
  view.rerender(<AdventurePanel service={{...service}} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  expect(screen.getAllByRole("heading",{level:3}).map(x=>x.textContent)).toEqual(["alpha","beta"]);
  expect(within(screen.getByRole("region",{name:"beta"})).getByText("团队服务离线")).toBeTruthy();
});
it("uses the existing Lead role boundary instead of names and includes all registered Leads", () => {
  const service=fixture();
  service.snapshots.alpha.members.push({...member("alpha","Lead · claude"),email:"second-lead@example.invalid",tmux:{id:"$5",created:5,name:"second-lead"}}, {...member("alpha","Leadership"),email:"plain-worker@example.invalid"});
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  expect(screen.getByText("second-lead")).toBeTruthy();
  expect(screen.queryByText("plain-worker")).toBeNull();
});
it("lists Leads without Lead role when tmux ends with -lead and shows tmux name without email", () => {
  const service = fixture();
  const worker = member("alpha", "worker");
  const lead = {...member("alpha", "claude · Opus"), email: "", id: "member-31efabcd",
    tmux: { id: "$8", created: 2, name: "smart-table-lead" }, host: servers[0].host};
  service.snapshots.alpha.members = [worker, lead];
  service.snapshots.alpha.live = {
    [memberKey(lead)]: { key: memberKey(lead), state: "idle", match: "exact", detail: "", machine: "East" },
  };
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  expect(within(screen.getByRole("region", { name: "alpha" })).getByRole("button", { name: /打开 Lead/ }).getAttribute("title")).toBe("smart-table-lead\nclaude · Opus");
  expect(screen.getByRole("region", { name: "alpha" }).querySelector(".adventure-meta-agent")?.textContent).toBe("smart-table-lead · claude · Opus");
  expect(screen.queryByText(/member-31ef/)).toBeNull();
});
it("prefers team snapshot project title over slug in section headings", () => {
  const service = fixture();
  service.projects = ["new_smart_table"];
  service.snapshots = {
    new_smart_table: {
      ...service.snapshots.alpha, project: "new_smart_table", title: "芯流-计算中心",
      members: [member("new_smart_table", "Lead · codex")],
      live: {}, identity: "x",
    },
  };
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  expect(screen.getByRole("heading", { level: 3, name: "芯流-计算中心" })).toBeTruthy();
});
it("registers the Crown entry on the right for SSH and local terminals", () => {
  const onSelect=vi.fn();
  const view=render(<ToolRail side="right" active={null} onSelect={onSelect}/>);
  const button=screen.getByRole("button",{name:"冒险团"});
  expect(button.querySelector(".lucide-crown")).toBeTruthy();
  fireEvent.click(button);expect(onSelect).toHaveBeenCalledWith("adventure");
  view.rerender(<ToolRail side="right" local active="adventure" onSelect={onSelect}/>);
  expect(screen.getByRole("button",{name:"冒险团"}).getAttribute("aria-pressed")).toBe("true");
});
// dssh/T86: Lead names in the guild carry no machine segment; the click still opens that exact member.
it("shows Leads without the -cwN machine segment and still opens the same member", async () => {
  const service = fixture(), onOpen = vi.fn().mockResolvedValue(undefined);
  const withTmux = {...member("alpha", "Lead · claude"), email: "nst-vision-cw2-lead@example.invalid", tmux: { id: "$7", created: 7, name: "nst-vision-lead" }};
  const noTmux = {...member("beta", "Lead · codex", servers[1].host), email: "dcollab-cw1-lead@example.invalid", tmux: { id: "", created: 0, name: "" }};
  service.snapshots.alpha.members = [member("alpha", "worker"), withTmux];
  service.snapshots.beta.members = [member("beta", "worker"), noTmux];
  service.snapshots.alpha.live = {}; service.snapshots.beta.live = {};
  const { container } = render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={onOpen} onClose={()=>{}}/>);
  expect(within(screen.getByRole("region", { name: "alpha" })).getByRole("button", { name: /打开 Lead/ }).getAttribute("title")).toBe("nst-vision-lead\nclaude\nnst-vision-cw2-lead@example.invalid");
  expect(screen.getByRole("region", { name: "alpha" }).querySelector(".adventure-meta-agent")?.textContent).toBe("nst-vision-lead · claude");
  expect(within(screen.getByRole("region", { name: "beta" })).getByRole("button", { name: /打开 Lead/ }).getAttribute("title")).toBe("dcollab-lead\ncodex\ndcollab-cw1-lead@example.invalid");
  expect(screen.getByRole("region", { name: "beta" }).querySelector(".adventure-meta-agent")?.textContent).toBe("dcollab-lead · codex");
  expect(container.textContent).not.toMatch(/-cw\d/);
  fireEvent.click(screen.getByRole("button", { name: "打开 Lead · alpha · nst-vision-lead" }));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(withTmux, servers[0]));
  expect(withTmux.email).toBe("nst-vision-cw2-lead@example.invalid");
});

// dssh/T87: one card per project, a pixel avatar per Lead, the box/email only on hover.
it("renders a single Lead as one project card with avatar, text status and hover-only identity", () => {
  const service = fixture();
  const { container } = render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  const alpha = screen.getByRole("region", { name: "alpha" });
  expect(alpha.classList.contains("is-solo")).toBe(true);
  expect(within(alpha).getByRole("heading", { level: 3 }).textContent).toBe("alpha");
  expect(alpha.querySelector(".team-member-avatar")?.getAttribute("data-state")).toBe("idle");
  expect(alpha.querySelector(".adventure-crown")).toBeTruthy();
  expect(within(alpha).getByText("空闲").classList.contains("adventure-status")).toBe(true);
  const stuck = screen.getByRole("region", { name: "beta" }).querySelector(".adventure-status")!;
  expect(stuck.textContent).toBe("卡住");
  expect(stuck.className).toContain("is-bad");
  const open = within(alpha).getByRole("button", { name: "打开 Lead · alpha · alpha-lead" });
  expect(open.getAttribute("title")).toBe("alpha-lead\ncodex\nalpha-lead-codex@example.invalid");
  // T87 rework: the Lead name leads the secondary line; the mailbox stays hover-only.
  expect(alpha.querySelector(".adventure-identity h3+.adventure-meta .adventure-meta-agent")?.textContent).toBe("alpha-lead · codex");
  expect(container.textContent).not.toMatch(/@example\.invalid|lead-codex/);
});
it("lists several Leads in one card with small avatars and names, and greys out replaced or offline ones", () => {
  const service = fixture();
  const second = {...member("alpha", "Lead · claude"), email: "alpha-two@example.invalid", tmux: { id: "$9", created: 9, name: "alpha-two-lead" }};
  service.snapshots.alpha.members.push(second);
  service.snapshots.alpha.live[memberKey(second)] = { key: memberKey(second), state: "running", match: "replaced", detail: "", machine: "East" };
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  const alpha = screen.getByRole("region", { name: "alpha" });
  expect(alpha.classList.contains("is-solo")).toBe(false);
  expect(within(alpha).getByRole("heading", { level: 3 }).textContent).toBe("alpha");
  expect(within(alpha).getByText("alpha-lead")).toBeTruthy();
  expect(within(alpha).getByText("alpha-two-lead")).toBeTruthy();
  const avatars = [...alpha.querySelectorAll(".team-member-avatar")];
  expect(avatars.map(avatar => avatar.getAttribute("data-state"))).toEqual(["idle", "unknown"]);
  expect(avatars.every(avatar => (avatar as HTMLElement).style.width === "28px")).toBe(true);
  expect(within(alpha).getByText("会话已替换")).toBeTruthy();
  expect(within(alpha).getByText("空闲")).toBeTruthy();
  expect(alpha.textContent).not.toMatch(/@example\.invalid/);
});
it("shows an empty seat and the next step when a project has no Lead", () => {
  const service = fixture();
  service.snapshots.alpha.members = [member("alpha", "worker")];
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  const alpha = screen.getByRole("region", { name: "alpha" });
  expect(within(alpha).getByRole("heading", { level: 3 }).textContent).toBe("alpha");
  expect(alpha.querySelector(".adventure-avatar.is-vacant")).toBeTruthy();
  expect(alpha.querySelector(".team-member-avatar")).toBeNull();
  expect(within(alpha).getByText("未登记 Lead")).toBeTruthy();
  expect(within(alpha).queryByRole("button")).toBeNull();
});
it("keeps tool · model and machine as two unbreakable chunks", () => {
  render(<AdventurePanel service={fixture()} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  const meta = screen.getByRole("region", { name: "alpha" }).querySelector(".adventure-meta")!;
  expect([...meta.children].map(child => child.className)).toEqual(["adventure-meta-agent", "adventure-meta-machine"]);
  expect(meta.children[0].children).toHaveLength(0);
  expect(meta.children[1].textContent).toBe("East");
});
it("gives the current projects pairwise different avatar colours, stable per slug", () => {
  const slugs = ["smart-table", "datrix", "dnotes", "dcollab", "nst-vision"];
  expect(new Set(slugs.map(teamAvatarShirt)).size).toBe(slugs.length);
  expect(slugs.map(teamAvatarShirt)).toEqual(slugs.map(teamAvatarShirt));
  const service = fixture();
  service.projects = slugs;
  service.snapshots = Object.fromEntries(slugs.map(slug => [slug, {...service.snapshots.alpha, project: slug, members: [member(slug, "Lead · codex")], live: {}}]));
  const { container } = render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  const shirts = [...container.querySelectorAll<HTMLElement>(".team-member-avatar")].map(avatar => avatar.style.getPropertyValue("--avatar-shirt"));
  expect(shirts).toHaveLength(5);
  expect(new Set(shirts).size).toBe(5);
});
