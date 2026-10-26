import {act,fireEvent,render,screen,within} from "@testing-library/react";
import {afterEach,expect,it,vi} from "vitest";
import TeamOffice from "../src/components/TeamOffice";
import {buildOfficeSnapshot,officeTeamSources,type OfficeSnapshot,type OfficeRoster} from "../src/lib/teamOffice";
import {collaborationKey,emptyProfile} from "../src/lib/collaboration";
import {parseAgentSessions,briefKey} from "../src/lib/agentSessions";
import type {TeamMember} from "../src/lib/teamMembers";
import type {ServerEntry} from "../src/types";
const server:ServerEntry & {password:string}={id:"saved",name:"Demo",host:"example.test",port:22,username:"dev",authMethod:"password",password:"DO_NOT_PUBLISH"};
const profile={...emptyProfile(),enabled:true,membersEnabled:true,project:"alpha",workdir:"/private/worktree",tmuxId:"$1",tmuxCreated:100,tmuxName:"lead",tokenFile:"/private/token",mailctlPath:"/private/mailctl.py"};
const member:TeamMember={project:"alpha",email:"worker@example.test",role:"Worker",host:server.host,port:22,username:"dev",workdir:"/repo",tmux:{id:"$2",created:123,name:"worker"},currentTask:"manual task\nsecond line"};
const session=(s=server)=>({pane:{id:"pane",server:s,tmux:profile},backendId:"private-backend"});
const profiles=()=>({[collaborationKey(server.id,profile)]:profile});
const context=()=>({servers:[server],sessions:[session()],themeId:"one-light",animationEnabled:true});
const sources=()=>officeTeamSources(profiles(),[server],[session()]);
const ready=(members=[member]):OfficeRoster=>({availability:"ready",notice:"",members});
afterEach(()=>{vi.restoreAllMocks();localStorage.clear();});
it("enumerates registered teams only and deduplicates exact endpoint/worktree/project aliases",()=>{
 const alias={...server,id:"alias",host:" EXAMPLE.TEST "};const p2={...profile,tmuxId:"$3",tmuxCreated:300};
 const input={...profiles(),[collaborationKey(alias.id,p2)]:p2};
 const found=officeTeamSources(input,[server,alias],[session(alias)]);
 expect(found).toHaveLength(1);expect(found[0].backendId).toBe("private-backend");
 expect(officeTeamSources({},[server],[session()])).toEqual([]);
 expect(officeTeamSources({[collaborationKey(server.id,profile)]:{...profile,membersEnabled:false}},[server],[session()])).toEqual([]);
 expect(officeTeamSources({[collaborationKey(server.id,profile)]:{...profile,enabled:false}},[server],[session()])).toEqual([]);
});
it("retains separate source sections for same project in different worktrees and endpoints",()=>{
 const other={...profile,workdir:"/other",tmuxId:"$4"};const remote={...server,id:"elsewhere",port:2222};
 const found=officeTeamSources({...profiles(),[collaborationKey(server.id,other)]:other,[collaborationKey(remote.id,profile)]:profile},[server,remote],[session()]);
 expect(found).toHaveLength(3);const result=buildOfficeSnapshot(found,{},context());
 expect(result.projects).toHaveLength(1);expect(result.projects[0].sources).toHaveLength(3);expect(new Set(result.projects[0].sources.map(s=>s.id)).size).toBe(3);
});
it("keeps unavailable registered teams visible instead of pretending their roster is empty-ready",()=>{
 const found=officeTeamSources(profiles(),[server],[]);expect(found).toHaveLength(1);
 const result=buildOfficeSnapshot(found,{},context());expect(result.projects[0].sources[0]).toMatchObject({availability:"offline",members:[]});
 const failed=buildOfficeSnapshot(found,{[found[0].id]:{availability:"error",notice:"Cannot read team",members:[member]}},context());
 expect(failed.projects[0].sources[0]).toMatchObject({availability:"error",notice:"Cannot read team",members:[]});
});
it("serializes only display fields, never server credentials, profiles, handles or mailbox addresses",()=>{
 const found=sources();const result=buildOfficeSnapshot(found,{[found[0].id]:ready()},context());
 expect(JSON.parse(JSON.stringify(result))).toEqual(result);
 expect(Object.keys(result).sort()).toEqual(["animationEnabled","mailAvailability","projects","themeId","version"]);
 const station=result.projects[0].sources[0].members[0];
 expect(Object.keys(station).sort()).toEqual(["ai","aiEnabled","detail","id","isLead","liveState","machine","machineOnline","machineVersion","match","model","name","paletteKey","responsibilities","role","since","status","taskFull","taskSource","taskText","tool","updatedAt"]);
 expect(station).toMatchObject({name:"worker",role:"Worker",taskText:"manual task",taskSource:"manual",status:{state:"unknown",source:"activity"}});
 const wire=JSON.stringify(result);for(const secret of [server.password,"private-backend",profile.workdir,profile.tokenFile,profile.mailctlPath,member.email])expect(wire).not.toContain(secret);
 expect(result.mailAvailability).toBe("unavailable");
});
it("keeps stable unique workstations across additions/removals, puts registered Lead first, and does not invent a Lead",()=>{
 const found=sources(),id=found[0].id;const lead={...member,email:"lead@example.test",role:"Lead"};
 const first=buildOfficeSnapshot(found,{[id]:ready()},context());expect(first.projects[0].sources[0].members).toHaveLength(1);expect(first.projects[0].sources[0].members[0].isLead).toBe(false);
 const expanded=buildOfficeSnapshot(found,{[id]:ready([member,lead])},context()).projects[0].sources[0].members;
 expect(expanded.map(m=>m.name)).toEqual(["lead","worker"]);expect(expanded[1].id).toBe(first.projects[0].sources[0].members[0].id);expect(expanded[0].id).not.toBe(expanded[1].id);
 expect(buildOfficeSnapshot(found,{[id]:ready([])},context()).projects[0].sources[0].members).toEqual([]);
});
it("uses current board task over handwritten notes but falls back when board is offline",()=>{
 const found=sources(),id=found[0].id;const board={offline:false,snapshot:parseAgentSessions({sessions:[{host:member.host,session:member.tmux.name,project:"alpha",task_code:"T1",host_ok:true,stale:false}]}),briefs:{[briefKey("alpha","T1")]:{code:"T1",title:"Current task",brief:"Current brief"}}};
 const station=(offline:boolean)=>buildOfficeSnapshot(found,{[id]:ready()},{...context(),boards:{[id]:{...board,offline}}}).projects[0].sources[0].members[0];
 expect(station(false)).toMatchObject({taskSource:"board",taskText:"T1 · Current brief"});expect(station(true)).toMatchObject({taskSource:"manual",taskText:"manual task"});
});
const room=():OfficeSnapshot=>({version:1,themeId:"one-light",animationEnabled:true,mailAvailability:"unavailable",projects:[{id:"alpha",name:"Alpha",sources:[{id:"s1",label:"Demo",availability:"ready",notice:"",members:["working","idle","unknown","done","blocked","error"].map((state,i)=>({id:"m"+i,name:state,isLead:i===0,status:{state:state as any,source:"program",label:state},taskText:"Task "+i,taskSource:"manual",paletteKey:"m"+i}))}]},{id:"beta",name:"Beta",sources:[{id:"s2",label:"Other",availability:"offline",notice:"Disconnected",members:[]}]}]});
it("renders multiple project areas and six states with a static unavailable-mail notice",()=>{
 const view=render(<TeamOffice snapshot={room()}/>);
 expect(screen.getByRole("region",{name:"公司办公室"})).toBeTruthy();expect(screen.getByRole("region",{name:"项目 Alpha"})).toBeTruthy();expect(screen.getByRole("region",{name:"项目 Beta"})).toBeTruthy();
 expect(view.container.querySelectorAll("[data-member-id]")).toHaveLength(6);expect(screen.getByText(/邮件动态未配置/)).toBeTruthy();expect(screen.getByText("Disconnected")).toBeTruthy();
 for(const state of ["working","idle","unknown","done","blocked","error"])expect(view.container.querySelector(`[data-state="${state}"]`)).toBeTruthy();
});
it("collapses project without unmounting its avatars and resumes only when visible",()=>{
 const value=room();const view=render(<TeamOffice snapshot={value}/>);const avatar=view.container.querySelector('.team-member-avatar[data-state="working"]')!;
 expect(avatar.getAttribute("data-paused")).toBe("false");fireEvent.click(screen.getByRole("button",{name:"折叠项目 Alpha"}));
 expect(view.container.querySelector('.team-member-avatar[data-state="working"]')).toBe(avatar);expect(avatar.getAttribute("data-paused")).toBe("true");
 fireEvent.click(screen.getByRole("button",{name:"展开项目 Alpha"}));expect(avatar.getAttribute("data-paused")).toBe("false");
 view.rerender(<TeamOffice snapshot={value} visible={false}/>);expect(avatar.getAttribute("data-paused")).toBe("true");
 view.rerender(<TeamOffice snapshot={value} visible/>);expect(avatar.getAttribute("data-paused")).toBe("false");
});
it("pauses on document visibility and keeps static state artwork when animation is disabled",()=>{
 const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);const value=room();const view=render(<TeamOffice snapshot={value}/>);const avatar=view.container.querySelector('.team-member-avatar[data-state="working"]')!;
 hidden.mockReturnValue(true);act(()=>document.dispatchEvent(new Event("visibilitychange")));expect(avatar.getAttribute("data-paused")).toBe("true");
 hidden.mockReturnValue(false);act(()=>document.dispatchEvent(new Event("visibilitychange")));expect(avatar.getAttribute("data-paused")).toBe("false");
 view.rerender(<TeamOffice snapshot={{...value,animationEnabled:false}}/>);expect(avatar.getAttribute("data-motion")).toBe("off");expect(avatar.querySelector("svg")).toBeTruthy();
});
it("updates members without losing other project sections and offers pop-out through callback",()=>{
 const value=room(),open=vi.fn();const view=render(<TeamOffice snapshot={value} onPopOut={open}/>);
 fireEvent.click(screen.getByRole("button",{name:"弹出窗口"}));expect(open).toHaveBeenCalledTimes(1);
 const next=structuredClone(value);next.projects[0].sources[0].members.splice(0,1);view.rerender(<TeamOffice snapshot={next} onPopOut={open}/>);
 expect(view.container.querySelectorAll("[data-member-id]")).toHaveLength(5);expect(view.container.querySelector('[data-member-id="m0"]')).toBeNull();expect(screen.getByRole("region",{name:"项目 Beta"})).toBeTruthy();
});
it("offers adaptive sizing plus integer scales without changing the pixel viewBox",()=>{
 const view=render(<TeamOffice snapshot={room()}/>);const svg=view.container.querySelector('.team-member-avatar svg')!;
 expect(svg.getAttribute("width")).toBe("28");expect(svg.getAttribute("height")).toBe("32");
 const select=screen.getByRole("combobox",{name:"房间像素缩放"});expect(within(select).getAllByRole("option").map(option=>option.getAttribute("value"))).toEqual(["auto","1","2","3"]);
 fireEvent.change(select,{target:{value:"1"}});expect(svg.getAttribute("width")).toBe("28");expect(svg.getAttribute("height")).toBe("32");
 fireEvent.change(select,{target:{value:"3"}});expect(svg.getAttribute("width")).toBe("84");expect(svg.getAttribute("height")).toBe("96");expect(svg.getAttribute("viewBox")).toBe("0 0 28 32");
});
it("starts paused when document is already hidden and shares one listener with complete cleanup",()=>{
 vi.spyOn(document,"hidden","get").mockReturnValue(true);const add=vi.spyOn(document,"addEventListener"),remove=vi.spyOn(document,"removeEventListener");const view=render(<TeamOffice snapshot={room()}/>);
 for(const avatar of view.container.querySelectorAll('.team-member-avatar'))expect(avatar.getAttribute("data-paused")).toBe("true");
 const listeners=add.mock.calls.filter(([name])=>name==="visibilitychange");expect(listeners).toHaveLength(1);view.unmount();expect(remove.mock.calls.some(([name,fn])=>name==="visibilitychange"&&fn===listeners[0][1])).toBe(true);
});
it("prefers a currently opened exact tmux incarnation when duplicate bindings share one roster",()=>{
 const newer={...profile,tmuxId:"$9",tmuxCreated:900};const found=officeTeamSources({...profiles(),[collaborationKey(server.id,newer)]:newer},[server],[{pane:{id:"active",server,tmux:{id:"$9",created:900,name:"new-lead"}},backendId:"ssh-new"}]);
 expect(found).toHaveLength(1);expect(found[0].profile).toEqual(newer);expect(found[0].backendId).toBe("ssh-new");
});

it("renders decorative empty desks without inventing members or member counts",()=>{
 const value=room();value.projects[1].sources[0]={id:"empty",label:"Empty team",availability:"ready",notice:"",members:[]};const view=render(<TeamOffice snapshot={value}/>);
 const empty=screen.getByRole("region",{name:"项目 Beta"});expect(empty.querySelectorAll(".office-empty-desk")).toHaveLength(3);expect(empty.querySelectorAll("[data-member-id]")).toHaveLength(0);
 for(const desk of empty.querySelectorAll(".office-empty-desk"))expect(desk.getAttribute("aria-hidden")).toBe("true");
 expect(view.container.querySelectorAll("[data-member-id]")).toHaveLength(6);expect(empty.querySelector(".office-project-sign")?.textContent).toContain("0 人");
});
it("uses shared room scenery and compact desk labels while preserving full status hints",()=>{
 const value=room();value.projects[0].sources[0].members[0].status.label="工作中（程序状态）";const view=render(<TeamOffice snapshot={value}/>);
 expect(view.container.querySelector(".office-upper-wall svg")).toBeTruthy();const station=view.container.querySelector('[data-member-id="m0"]')!;
 expect(station.querySelector(".office-desk-label .office-station-name")?.textContent).toContain("working");expect(station.querySelector(".office-member-status")?.textContent).toBe("工作中");expect(station.querySelector(".office-member-status")?.getAttribute("title")).toBe("工作中（程序状态）");
 expect(station.querySelector(".office-screen-code.office-motion")).toBeTruthy();expect(view.container.querySelector('.team-member-avatar[data-state="idle"] .team-avatar-sleep.team-avatar-motion')).toBeTruthy();
});

it("disambiguates source labels with the workdir basename without exposing the full path",()=>{
 const found=sources();expect(found[0].label).toContain("worktree");expect(found[0].label).not.toContain("/private/");
});

it("exposes full state meaning and handwritten provenance as readable text beyond hover titles",()=>{
 const value=room();value.projects[0].sources[0].members[0].status.label="正在编程（程序状态）";const view=render(<TeamOffice snapshot={value}/>);const station=screen.getByRole("article",{name:"工位 working"});
 const status=within(station).getByText("正在编程（程序状态）",{selector:"span.office-sr-only"});expect(status.closest('[aria-hidden="true"]')).toBeNull();expect(status.className).toBe("office-sr-only");
 const note=within(station).getByText("成员手写 ·");expect(note.closest('[aria-hidden="true"]')).toBeNull();expect(note.parentElement?.textContent).toContain("成员手写 · Task 0");expect(view.container.querySelectorAll('.office-station')).toHaveLength(6);
});
