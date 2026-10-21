import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resolveTeamAvatar } from "../src/lib/teamAvatar";
import { memberMappingKey, type TeamMember } from "../src/lib/teamMembers";
import type { TmuxProgramPane, TmuxProgramSnapshot } from "../src/lib/tmuxProgramStatus";
import type { ServerEntry } from "../src/types";
import TeamMemberAvatar from "../src/components/TeamMemberAvatar";
import SettingsModal from "../src/components/SettingsModal";
import { defaultSettings, loadSettings, saveSettings } from "../src/store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const server: ServerEntry = {id:"remote",name:"Remote",host:"host.example.test",port:22,username:"dev",authMethod:"password"};
const member: TeamMember = {project:"demo",email:"worker@example.test",role:"Worker",host:server.host,port:22,username:"dev",workdir:"/repo",tmux:{id:"$2",created:123,name:"worker"},currentTask:"working on tests"};
const session = (s = server, backendId = "ssh") => ({pane:{id:s.id,server:s,tmux:member.tmux},backendId});
const pane = (overrides: Partial<TmuxProgramPane> = {}): TmuxProgramPane => ({sessionId:"$2",sessionCreated:123,sessionName:"worker",paneId:"%1",windowId:"@1",windowActive:true,paneActive:true,state:"idle",...overrides});
const snapshot = (panes = [pane()], overrides: Partial<TmuxProgramSnapshot> = {}): TmuxProgramSnapshot => ({supported:true,error:"",panes,...overrides});
const context = (panes = [pane()]) => ({servers:[server],sessions:[session()],programSnapshots:{[server.id]:snapshot(panes)},mapping:{}});
const fallback = {state:"working",source:"activity"};
beforeEach(() => {localStorage.clear();vi.mocked(invoke).mockReset().mockResolvedValue(JSON.stringify([member]));});
afterEach(() => {vi.restoreAllMocks();});

it.each([["working on tests","working"],["idle","idle"],["unknown","unknown"],["","unknown"]])("maps activity %s to %s without an attributed program",(currentTask,state)=>{
  expect(resolveTeamAvatar({...member,currentTask},{servers:[],sessions:[]})).toMatchObject({state,source:"activity"});
});
it.each(["idle","working","done","blocked","error"] as const)("program %s takes precedence over handwritten working",state=>{
  expect(resolveTeamAvatar(member,context([pane({state})]))).toMatchObject({state,source:"program"});
});
it.each(["permission","question","auth",undefined] as const)("preserves blocked reason %s",kind=>{
  const status=resolveTeamAvatar(member,context([pane({state:"blocked",kind})]));
  expect(status).toMatchObject({state:"blocked",source:"program"});
  expect(status.kind).toBe(kind);
  expect(status.label).toContain(kind === "permission" ? "等待授权" : kind === "question" ? "等待回答" : kind === "auth" ? "等待认证" : "等待处理");
});
it.each([
  ["error","blocked"],["blocked","working"],["working","done"],["done","idle"],
] as const)("inactive %s pane outranks active %s in either input order",(higher,lower)=>{
  const panes=[pane({state:lower}),pane({paneId:"%2",state:higher,paneActive:false,windowActive:false})];
  for(const candidates of [panes,[...panes].reverse()])expect(resolveTeamAvatar(member,context(candidates)).state).toBe(higher);
});
it("chooses a stable blocked reason across pane order and ignores absent program reports",()=>{
  const panes=[pane({paneId:"%2",state:"blocked",kind:"auth"}),pane({state:"blocked",kind:"permission"}),pane({paneId:"%3",state:null})];
  for(const candidates of [panes,[...panes].reverse()])expect(resolveTeamAvatar(member,context(candidates))).toMatchObject({state:"blocked",kind:"permission"});
  expect(resolveTeamAvatar(member,context([pane({state:null})]))).toMatchObject(fallback);
});
it.each([{sessionId:"$9"},{sessionCreated:124},{sessionId:"$9",sessionCreated:124}])("never uses same-name sessions with a mismatched identity: %j",identity=>{
  expect(resolveTeamAvatar(member,context([pane({...identity,sessionName:member.tmux.name})]))).toMatchObject(fallback);
});
it("accepts a renamed session only when id and creation still match",()=>{
  expect(resolveTeamAvatar(member,context([pane({sessionName:"renamed"})]))).toMatchObject({state:"idle",source:"program"});
});
it.each([{host:"other.example.test"},{port:2222},{username:"root"}])("rejects alternate routes without explicit mapping: %j",endpoint=>{
  const other={...server,...endpoint};
  expect(resolveTeamAvatar(member,{...context(),servers:[other],sessions:[session(other)]})).toMatchObject(fallback);
});
it("accepts normalized host case and whitespace without relaxing port or user",()=>{
  const normalized={...server,host:" HOST.EXAMPLE.TEST "};
  expect(resolveTeamAvatar(member,{...context(),servers:[normalized],sessions:[session(normalized)]})).toMatchObject({state:"idle",source:"program"});
});
it("does not mistake a local terminal for an identical SSH endpoint",()=>{
  const local={...server,kind:"local" as const};
  expect(resolveTeamAvatar(member,{...context(),servers:[local],sessions:[session(local)]})).toMatchObject(fallback);
});
it("uses an explicit alternate endpoint mapping and refuses missing or stale mappings",()=>{
  const alias={...server,id:"alias",host:"alias.example.test",port:2222};
  const ctx={servers:[server,alias],sessions:[session(alias)],programSnapshots:{alias:snapshot()},mapping:{[memberMappingKey(member)]:alias.id}};
  expect(resolveTeamAvatar(member,ctx)).toMatchObject({state:"idle",source:"program"});
  expect(resolveTeamAvatar(member,{...ctx,mapping:{}})).toMatchObject(fallback);
  expect(resolveTeamAvatar(member,{...context(),mapping:{[memberMappingKey(member)]:"deleted"}})).toMatchObject(fallback);
  expect(resolveTeamAvatar(member,{...ctx,programSnapshots:{alias:snapshot([pane({sessionCreated:999})])}})).toMatchObject(fallback);
});
it.each(["disconnected","missing","error","unsupported"])("falls back from %s instead of showing retained program idle",mode=>{
  const ctx=context();
  if(mode==="disconnected")ctx.sessions=[session(server,"")];
  if(mode==="missing")ctx.programSnapshots={};
  if(mode==="error")ctx.programSnapshots[server.id].error="connection failed";
  if(mode==="unsupported")ctx.programSnapshots[server.id].supported=false;
  expect(resolveTeamAvatar(member,ctx)).toMatchObject(fallback);
});
it("requires a live endpoint even when a cached snapshot exists",()=>{
  expect(resolveTeamAvatar(member,{...context(),sessions:[]})).toMatchObject(fallback);
});
it("allows identical live endpoint aliases but rejects conflicting reports",()=>{
  const alias={...server,id:"alias"};
  const ctx={...context(),servers:[server,alias],sessions:[session(),session(alias)],programSnapshots:{remote:snapshot(),alias:snapshot()}};
  expect(resolveTeamAvatar(member,ctx)).toMatchObject({state:"idle",source:"program"});
  ctx.programSnapshots.alias=snapshot([pane({state:"error"})]);
  expect(resolveTeamAvatar(member,ctx)).toMatchObject(fallback);
});
it.each(["missing","error","unsupported"])("rejects an ambiguous live alias with %s snapshot",mode=>{
  const alias={...server,id:"alias"};
  const snapshots:Record<string,TmuxProgramSnapshot>={remote:snapshot(),alias:snapshot()};
  if(mode==="missing")delete snapshots.alias;
  if(mode==="error")snapshots.alias.error="failed";
  if(mode==="unsupported")snapshots.alias.supported=false;
  expect(resolveTeamAvatar(member,{servers:[server,alias],sessions:[session(),session(alias)],programSnapshots:snapshots})).toMatchObject(fallback);
});
it("rejects conflicting blocked reasons across aliases",()=>{
  const alias={...server,id:"alias"};
  expect(resolveTeamAvatar(member,{servers:[server,alias],sessions:[session(),session(alias)],programSnapshots:{remote:snapshot([pane({state:"blocked",kind:"auth"})]),alias:snapshot([pane({state:"blocked",kind:"permission"})])}})).toMatchObject(fallback);
});

it("retains distinct static artwork and accessible state descriptions for all six states",()=>{
  const artwork=new Set<string>();
  for(const state of ["working","idle","unknown","done","blocked","error"] as const){
    const status=state==="unknown"?resolveTeamAvatar({...member,currentTask:"unknown"},{servers:[],sessions:[]}):resolveTeamAvatar(member,context([pane({state})]));
    const view=render(<TeamMemberAvatar memberId="worker" status={status} motionEnabled={false}/>);
    const svg=screen.getByRole("img");
    const avatar=svg.closest("[data-state]")!;
    expect(svg.getAttribute("aria-label")).toContain(status.label);
    expect(avatar.getAttribute("data-state")).toBe(state);
    expect(avatar.getAttribute("data-motion")).toBe("off");
    expect(svg).toBeTruthy();
    artwork.add(svg.innerHTML.replace(/<title>.*?<\/title>/g,""));
    view.unmount();
  }
  expect(artwork.size).toBe(6);
});

it("defaults old settings to animation enabled and persists the user's checkbox choice across remount",()=>{
  localStorage.setItem("dssh.settings",JSON.stringify({theme:"dark",fontSize:14}));
  expect(defaultSettings().teamAvatarAnimation).toBe(true);
  expect(loadSettings().teamAvatarAnimation).toBe(true);
  function Harness(){
    const [settings,setSettings]=useState(loadSettings);
    return <SettingsModal settings={settings} onClose={()=>{}} onChange={next=>{saveSettings(next);setSettings(next);}}/>;
  }
  const view=render(<Harness/>);
  const toggle=screen.getByRole("checkbox",{name:/房间像素动画/}) as HTMLInputElement;
  expect(toggle.checked).toBe(true);
  fireEvent.click(toggle);
  expect(toggle.checked).toBe(false);
  expect(loadSettings().teamAvatarAnimation).toBe(false);
  view.unmount();
  const again=render(<Harness/>);
  expect((screen.getByRole("checkbox",{name:/房间像素动画/}) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("checkbox",{name:/房间像素动画/}));
  expect(loadSettings().teamAvatarAnimation).toBe(true);
  again.unmount();
});
