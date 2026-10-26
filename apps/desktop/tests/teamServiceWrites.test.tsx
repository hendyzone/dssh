import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), listeners: new Map<string, Set<(event: {payload: unknown}) => void>>() }));
vi.mock("@tauri-apps/api/core", () => ({invoke: bridge.invoke}));
vi.mock("@tauri-apps/api/event", () => ({listen: bridge.listen}));
vi.mock("../src/lib/agentSessions", async original => ({...await original<typeof import("../src/lib/agentSessions")>(),useAgentSessions:()=>({briefs:{},statusNames:{},offline:false,error:""})}));
import TeamMembers from "../src/components/TeamMembers";
import { configureTeamService, useTeamService } from "../src/lib/teamService";
import { emptyProfile } from "../src/lib/collaboration";
import type { ServerEntry } from "../src/types";

const server: ServerEntry = {id:"example",name:"Example",host:"host-a",port:22,username:"dev",authMethod:"password"};
const profile = {...emptyProfile(), project:"demo", enabled:true};
const member = {project:"demo",email:"worker@example.invalid",role:"Worker",host:"host-a",port:22,username:"dev",workdir:"/srv/project",tmux:{id:"$2",created:123,name:"worker"},rev:7,responsibilities:"Old responsibility",currentTask:"待确认",notes:"Old note"};
const snap = (members=[member],seq=7) => ({type:"snapshot",project:"demo",seq,lseq:0,members,ai:{},live:{},machines:{}});
let native: any;
let failure: unknown;
let refreshed: ReturnType<typeof snap>;
let serial = 0;
function Probe(){return <output data-testid="state">{JSON.stringify(useTeamService())}</output>;}
function state(){return JSON.parse(screen.getByTestId("state").textContent!);}
async function emit(name:string,payload:unknown){await act(async()=>{for(const callback of bridge.listeners.get(name)??[])callback({payload});});}
async function boot(withCandidate=false){
  render(<><Probe/><TeamMembers sessionId="" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn(),sessions:withCandidate?[{pane:{id:"new-terminal",server:{...server,host:"host-b"},tmux:{id:"$9",created:456,name:"new-worker"}},backendId:"new-backend"}]:[]}}/></>);
  await waitFor(()=>expect(bridge.invoke).toHaveBeenCalledWith("team_service_read"));
  await act(async()=>{await configureTeamService(`https://writes-${++serial}.example.invalid`,"setup-only-secret",["demo"]);});
  await emit("team://status",native.status);
  await emit("team://snapshot",snap());
  const row=screen.getByRole("button",{name:"打开 · Worker · worker",hidden:true}).closest("details")!;
  const group=row.parentElement!.closest("details")!;
  await act(async()=>{group.open=true;fireEvent(group,new Event("toggle"));});
  await act(async()=>{row.open=true;fireEvent(row,new Event("toggle"));});
  await screen.findByRole("button",{name:"编辑备注 · Worker"});
  bridge.invoke.mockClear();
}
beforeEach(()=>{
  localStorage.clear();bridge.invoke.mockReset();bridge.listen.mockReset();failure=undefined;refreshed=snap([{...member,rev:8,notes:"Latest note",responsibilities:"Latest responsibility"}],8);
  native={url:null,projects:[],status:{state:"online",token_configured:true},snapshots:{}};
  bridge.listen.mockImplementation(async(name:string,callback:(event:{payload:unknown})=>void)=>{
    const set=bridge.listeners.get(name)??new Set();set.add(callback);bridge.listeners.set(name,set);return()=>set.delete(callback);
  });
  bridge.invoke.mockImplementation(async(command:string,args?:Record<string,unknown>)=>{
    if(command==="team_service_configure"){native.url=args?.url;native.snapshots={};return native.status;}
    if(command==="team_service_subscribe"){native.projects=args?.projects;return null;}
    if(command==="collaboration_worktree")return "/srv/new-project";
    if(command==="team_service_read")return structuredClone(native);
    if(command==="team_service_projects")return {projects:["demo"]};
    if(command==="team_service_refresh"){
      native.snapshots.demo=refreshed;
      await emit("team://snapshot",refreshed);
      return null;
    }
    if(["team_service_member_patch","team_service_members_put","team_service_member_delete"].includes(command)){
      if(failure)throw failure;
      return null;
    }
    throw Error(`Unexpected command ${command}`);
  });
});
afterEach(cleanup);

it("sends notes through Rust without credentials and only applies the subsequent WS delta",async()=>{
  await boot();fireEvent.click(screen.getByRole("button",{name:"编辑备注 · Worker"}));
  fireEvent.change(screen.getByLabelText("其他备注"),{target:{value:"New note"}});
  fireEvent.click(screen.getByRole("button",{name:"保存备注"}));
  await screen.findByText("写入已接受，等待团队服务同步。");
  expect(bridge.invoke).toHaveBeenCalledWith("team_service_member_patch",{project:"demo",key:member.email,patch:{responsibilities:member.responsibilities,currentTask:member.currentTask,notes:"New note"},rev:null});
  expect(state().snapshots.demo.members[0].notes).toBe("Old note");
  expect(bridge.invoke.mock.calls.map(([command])=>command)).toEqual(["team_service_member_patch"]);
  expect(JSON.stringify(bridge.invoke.mock.calls)).not.toMatch(/token|setup-only-secret/);
  await emit("team://delta",{type:"delta",project:"demo",seq:8,ops:[{op:"upsert",member:{...member,rev:8,notes:"New note"}}]});
  expect(state().snapshots.demo.members[0].notes).toBe("New note");
  expect(state().snapshots.demo.members).toHaveLength(1);
});
it.each(["rev_mismatch","if_match_required"])("refreshes and refills on 412 %s without retrying the write",async code=>{
  await boot();failure={status:412,code,message:"secret-error-body"};
  fireEvent.click(screen.getByRole("button",{name:"编辑备注 · Worker"}));
  fireEvent.change(screen.getByLabelText("其他备注"),{target:{value:"Stale draft"}});
  fireEvent.click(screen.getByRole("button",{name:"保存备注"}));
  await screen.findByText("名单已被他人修改，已刷新，请确认后重试");
  expect(bridge.invoke).toHaveBeenCalledWith("team_service_refresh",{project:"demo"});
  expect((screen.getByLabelText("其他备注") as HTMLTextAreaElement).value).toBe("Latest note");
  expect(state().snapshots.demo.members[0].rev).toBe(8);
  expect(bridge.invoke.mock.calls.filter(([name])=>name==="team_service_member_patch")).toHaveLength(1);
  expect(document.body.textContent).not.toContain("secret-error-body");
});
it("deletes with the exact displayed tmux and revision, leaving the row until a delta",async()=>{
  await boot();fireEvent.click(screen.getByRole("button",{name:"从团队移除"}));
  await screen.findByText("删除已接受，等待团队服务同步。");
  expect(bridge.invoke).toHaveBeenCalledWith("team_service_member_delete",{project:"demo",key:member.email,tmux:"$2:123",rev:7});
  expect(state().snapshots.demo.members).toHaveLength(1);
  await emit("team://delta",{type:"delta",project:"demo",seq:8,ops:[{op:"remove",key:member.email}]});
  expect(state().snapshots.demo.members).toHaveLength(0);
});
it("reports a changed session on 409 without refreshing identity and retrying delete",async()=>{
  await boot();failure={status:409,code:"tmux_mismatch",message:"private-sentinel"};
  fireEvent.click(screen.getByRole("button",{name:"从团队移除"}));
  await screen.findByText("会话已更替，请刷新成员并核对当前会话后重试");
  expect(bridge.invoke.mock.calls.map(([command])=>command)).toEqual(["team_service_member_delete"]);
  expect(document.body.textContent).not.toContain("private-sentinel");
});
it("requires a second confirmation for position changes and carries per-item revisions in a batch",async()=>{
  await boot();
  await act(async()=>{for(const label of ["更多","高级：导入或分享成员位置"]){const details=screen.getByText(label).closest("details")!;details.open=true;fireEvent(details,new Event("toggle"));}});
  const batch=[{...member,host:"host-b",password:"never-forward",aiSummary:"read-only"},{...member,email:"other@example.invalid",rev:undefined,role:"Other"}];
  fireEvent.change(screen.getByLabelText("成员位置 JSON（单个或批量数组）"),{target:{value:JSON.stringify(batch)}});
  fireEvent.click(screen.getByRole("button",{name:"登记到当前团队"}));
  await screen.findByRole("dialog",{name:"确认成员位置变更"});
  expect(bridge.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"取消位置变更"}));
  expect(bridge.invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"登记到当前团队"}));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByRole("button",{name:"确认位置变更"}));
  await screen.findByText("写入已接受，等待团队服务同步。");
  const call=bridge.invoke.mock.calls.find(([command])=>command==="team_service_members_put")!;
  expect(call[1].members[0]).toMatchObject({host:"host-b",rev:7});
  expect(call[1].members[1].rev).toBeUndefined();
  expect(JSON.stringify(call)).not.toMatch(/password|never-forward|aiSummary|token/);
  expect(state().snapshots.demo.members[0].host).toBe("host-a");
});
it("never renders arbitrary native error bodies or persists secrets from a failed write",async()=>{
  await boot();failure={status:500,code:"internal_error",message:"credential-should-stay-native"};
  fireEvent.click(screen.getByRole("button",{name:"从团队移除"}));
  await screen.findByText("团队服务操作失败，请检查连接、权限及输入后重试");
  expect(document.body.textContent).not.toContain("credential-should-stay-native");
  expect(JSON.stringify(localStorage)).not.toMatch(/credential-should-stay-native|setup-only-secret/);
});

it("confirms a selected terminal change before PATCH and sends the reviewed revision",async()=>{
  await boot(true);
  fireEvent.click(screen.getByRole("button",{name:"更新终端"}));
  fireEvent.change(screen.getByLabelText("成员终端"),{target:{value:"new-terminal"}});
  fireEvent.click(within(screen.getByLabelText("添加成员表单")).getByRole("button",{name:"更新终端"}));
  await screen.findByRole("dialog",{name:"确认成员位置变更"});
  expect(bridge.invoke.mock.calls.map(([name])=>name)).toEqual(["collaboration_worktree"]);
  fireEvent.click(screen.getByRole("button",{name:"确认位置变更"}));
  await screen.findByText("写入已接受，等待团队服务同步。");
  expect(bridge.invoke).toHaveBeenCalledWith("team_service_member_patch",{project:"demo",key:member.email,rev:7,patch:{role:"Worker",host:"host-b",port:22,username:"dev",workdir:"/srv/new-project",tmux:{id:"$9",created:456,name:"new-worker"}}});
});
it("allows a name edit without changing position or requesting a position confirmation",async()=>{
  await boot();fireEvent.click(screen.getByRole("button",{name:"更新终端"}));
  fireEvent.change(screen.getByLabelText("成员名称"),{target:{value:"Reviewer"}});
  fireEvent.click(within(screen.getByLabelText("添加成员表单")).getByRole("button",{name:"更新终端"}));
  await screen.findByText("写入已接受，等待团队服务同步。");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(bridge.invoke).toHaveBeenCalledWith("team_service_member_patch",{project:"demo",key:member.email,patch:{role:"Reviewer"},rev:null});
});
