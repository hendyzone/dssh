import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AdventurePanel from "../src/components/AdventurePanel";
import ToolRail from "../src/components/ToolRail";
import type { TeamServiceState, TeamServiceProject } from "../src/lib/teamService";
import { memberKey, type TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

const server = (id: string): ServerEntry => ({id, name: id, host: `${id}.example.invalid`, port: 22, username: "demo", authMethod: "password"});
const servers = [server("east"), server("west")];
const member = (project: string, role: string, host = servers[0].host): TeamMember => ({project, email: `${project}-${role.startsWith("Lead") ? "lead-codex" : "worker"}@example.invalid`, role, host, port:22, username:"demo", workdir:`/work/${project}`, tmux:{id:"$1",created:1,name:project}});
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
  expect(screen.getByText("codex · West")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"打开 Lead · beta · beta-lead-codex"}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledWith(service.snapshots.beta.members[1],servers[1]));
});
it("keeps missing rosters, no Lead, unavailable connections and click errors local to their row", async () => {
  const service = fixture();
  service.projects.push("empty","broken","unmapped");
  service.snapshots.empty = {...service.snapshots.alpha, project:"empty",members:[member("empty","worker")]};
  service.snapshots.unmapped = {...service.snapshots.alpha,project:"unmapped",members:[member("unmapped","Lead","missing.example.invalid")]};
  const onOpen = vi.fn().mockRejectedValueOnce(new Error("连接失败")).mockResolvedValue(undefined);
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={onOpen} onClose={()=>{}}/>);
  expect(within(screen.getByRole("region",{name:"empty"})).getByText("未设置 Lead")).toBeTruthy();
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
  service.snapshots.alpha.members.push({...member("alpha","Lead · claude"),email:"second-lead@example.invalid"}, {...member("alpha","Leadership"),email:"looks-like-lead@example.invalid"});
  render(<AdventurePanel service={service} servers={servers} sessions={[]} onOpen={vi.fn()} onClose={()=>{}}/>);
  expect(screen.getByText("second-lead")).toBeTruthy();
  expect(screen.queryByText("looks-like-lead")).toBeNull();
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
