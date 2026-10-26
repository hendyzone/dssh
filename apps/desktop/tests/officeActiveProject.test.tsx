import { expect, it } from "vitest";
import { officeActiveProject } from "../src/lib/teamOffice";
import type { SessionInfo } from "../src/types";
const pane: SessionInfo = {id:"pane",server:{id:"saved",name:"Example",host:"host-a.example.invalid",port:22,username:"dev",authMethod:"password"},tmux:{id:"$7",created:123,name:"worker-alpha"}};
const member = (project="alpha", extra={}) => ({project,email:"worker@example.invalid",role:"Worker",host:pane.server.host,port:22,username:"dev",workdir:"/srv/project",tmux:pane.tmux,...extra});
const service = (members=[member()]) => ({projects:["alpha","beta"],snapshots:{alpha:{members},beta:{members:[]}}} as any);
it("identifies Lead naming conventions only for known project names",()=>{
 expect(officeActiveProject({...pane,tmux:{...pane.tmux!,name:"alpha-lead"}},service())).toBe("alpha");
 expect(officeActiveProject({...pane,tmux:{...pane.tmux!,name:"lead-beta"}},service())).toBe("beta");
 expect(officeActiveProject({...pane,tmux:{...pane.tmux!,name:"alpha"}},service([]))).toBeUndefined();
 expect(officeActiveProject({...pane,tmux:{...pane.tmux!,name:"unknown-lead"}},service([]))).toBeUndefined();
});
it("maps a worker by exact endpoint and tmux incarnation without relying on its name",()=>{
 expect(officeActiveProject({...pane,tmux:{...pane.tmux!,name:"renamed-worker"}},service())).toBe("alpha");
 const cached=service();cached.snapshots.alpha.offline=true;
 expect(officeActiveProject(pane,cached)).toBe("alpha");
 expect(officeActiveProject({...pane,tmux:{...pane.tmux!,created:124}},cached)).toBeUndefined();
 expect(officeActiveProject(undefined,service())).toBeUndefined();
 expect(officeActiveProject({...pane,tmux:undefined},service())).toBeUndefined();
});
it.each([
 {host:"other.example.invalid"},{port:2222},{username:"other"},{tmux:{...pane.tmux,id:"$8"}},{tmux:{...pane.tmux,created:124}},
])("rejects a worker identity mismatch %j",mismatch=>{
 expect(officeActiveProject(pane,service([member("alpha",mismatch)]))).toBeUndefined();
});
it("rejects cross-project ambiguity and unsubscribed member matches",()=>{
 const ambiguous=service();ambiguous.snapshots.beta.members=[member("beta")];
 expect(officeActiveProject(pane,ambiguous)).toBeUndefined();
 expect(officeActiveProject(pane,{...service(),projects:["beta"]})).toBeUndefined();
});

it("shares strict identity mapping with the team panel while keeping only its explicit UI fallback",async()=>{
 const {sessionTeamProject,paneTeamProject}=await import("../src/lib/tmuxGroups");
 expect(officeActiveProject).toBe(sessionTeamProject);
 const current=service([]);current.snapshots.beta.members=[member("beta")];
 expect(paneTeamProject(pane,undefined,undefined,current)).toBe("beta");
 current.snapshots.beta.members=[member("beta",{host:"wrong.example.invalid"})];
 expect(officeActiveProject(pane,current)).toBeUndefined();
 expect(paneTeamProject(pane,undefined,undefined,current)).toBe("alpha");
 expect(paneTeamProject(pane,"beta",undefined,current)).toBe("beta");
 current.snapshots.beta.members=[member("beta")];current.snapshots.alpha.members=[member()];
 expect(officeActiveProject(pane,current)).toBeUndefined();
});
