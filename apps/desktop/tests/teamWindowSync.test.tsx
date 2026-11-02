import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import TeamDynamics from "../src/components/TeamDynamics";
import TeamMembers from "../src/components/TeamMembers";
import TeamWindow from "../src/components/TeamWindow";
import { emptyProfile } from "../src/lib/collaboration";
import type { TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";
import {
  openTeamWindow, sendTeamWindowAction, shouldRestoreTeamWindow,
  useTeamWindowActions, useTeamWindowPresence, useTeamWindowPublisher, useTeamWindowSnapshot,
  type TeamWindowEnvelope, type TeamWindowSnapshot,
} from "../src/lib/teamWindowSync";

vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/event", () => ({listen:vi.fn()}));
const serviceFixture = vi.hoisted(() => ({current:{} as any}));
const refreshTeamServiceMock = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/teamService", () => ({useTeamService:()=>serviceFixture.current, refreshTeamService:refreshTeamServiceMock}));

const member: TeamMember = {project:"demo", email:"worker@example.test", role:"worker", host:"remote", port:22, username:"dev", workdir:"/repo", tmux:{id:"$2", created:123, name:"worker"}};
const server: ServerEntry = {id:"local-device-id", name:"开发机", host:"remote", port:22, username:"dev", authMethod:"password", hasPassword:true, keyPath:"/secret/key"};
const profile = {...emptyProfile(), enabled:true, taskboardEnabled:true, project:"demo", workdir:"/lead", tmuxId:"$1", tmuxCreated:100, tmuxName:"lead"};
const snapshot = (version: 1 = 1): TeamWindowSnapshot => ({
  version, themeId:"one-light", sessionId:"ssh", profile, members:[member],
  live:{briefs:{}, statusNames:{}, offline:false, error:""},
  serviceLive:{}, serviceAi:{}, aiEnabled:null, serviceIdentity:"demo",
  servers:[{id:server.id, name:server.name, host:server.host, port:server.port, username:server.username}],
});
const envelope = (sequence: number, epoch = "native-a"): TeamWindowEnvelope => ({epoch, sequence, snapshot:snapshot()});
const deferred = <T,>() => { let resolve!: (v:T)=>void; const promise = new Promise<T>(r=>{resolve=r}); return {promise, resolve}; };

let handlers: Record<string, (event:{payload:any})=>void>;
let offs: Record<string, ReturnType<typeof vi.fn>>;
function serviceRoster(members: TeamMember[]) {
  serviceFixture.current = {url:"https://team.example.invalid", projects:["demo"], status:{state:"online", token_configured:true},
    snapshots:{demo:{project:"demo", identity:"service-demo", seq:1, members, ai:{}, machines:{},
      live:Object.fromEntries(members.map(m=>[m.email||m.id,{match:"no_agent"}])), receivedAt:Date.now(), offline:false, status:"online"}}};
}
beforeEach(() => {
  handlers = {}; offs = {};
  serviceRoster([member]);
  vi.mocked(invoke).mockReset().mockImplementation(async (command: string) => {
    if (command === "team_window_exists") return true;
    if (command === "team_request_snapshot") return {snapshot: null};
    return undefined;
  });
  vi.mocked(listen).mockReset().mockImplementation(async (name: string, handler: any) => {
    handlers[name] = handler; offs[name] = vi.fn(); return offs[name];
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear(); });

// ── 入口：TeamDynamics 的「在新窗口打开」按钮，以及 TeamMembers host 实例的接线 ──

it("shows the open-window button only when onOpenWindow is given, and clicking calls it", () => {
  const navigation = {server, servers:[server], onOpen:vi.fn()};
  const onOpenWindow = vi.fn();
  const view = render(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={[member]} onUpdated={async()=>{}}/>);
  expect(screen.queryByRole("button", {name:"在新窗口打开团队面板"})).toBeNull();
  view.rerender(<TeamDynamics sessionId="ssh" profile={profile} navigation={navigation} members={[member]} onUpdated={async()=>{}} onOpenWindow={onOpenWindow}/>);
  fireEvent.click(screen.getByRole("button", {name:"在新窗口打开团队面板"}));
  expect(onOpenWindow).toHaveBeenCalledTimes(1);
});

it("invokes open_team_window from the TeamPanel-hosted instance's toolbar button", async () => {
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server, servers:[server], onOpen:vi.fn()}} teamWindowHost/>);
  fireEvent.click(await screen.findByRole("button", {name:"在新窗口打开团队面板"}));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("open_team_window"));
});

it("opens through the fixed native team command, and repeat calls simply re-invoke it (Rust focuses an existing window)", async () => {
  await openTeamWindow(); await openTeamWindow();
  expect(vi.mocked(invoke).mock.calls.filter(([cmd])=>cmd==="open_team_window")).toHaveLength(2);
});

// ── 发布端：useTeamWindowPresence / useTeamWindowPublisher ──

it("publishes no snapshots without team presence, deduplicates content and merges changes for 250ms", async () => {
  vi.useFakeTimers(); vi.mocked(invoke).mockResolvedValue(undefined);
  const view = renderHook(({value,exists}) => useTeamWindowPublisher(value,exists), {initialProps:{value:snapshot(), exists:false}});
  await act(async()=>{}); await act(async()=>vi.advanceTimersByTimeAsync(1000));
  expect(invoke).not.toHaveBeenCalled();
  view.rerender({value:snapshot(), exists:true}); await act(async()=>vi.advanceTimersByTimeAsync(250));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith("team_publish_snapshot", {snapshot:snapshot()});
  for (let i=0;i<4;i++) view.rerender({value:snapshot(), exists:true});
  await act(async()=>{handlers["team:request"]({payload:null}); await vi.advanceTimersByTimeAsync(1000);});
  expect(invoke).toHaveBeenCalledTimes(1);     // 内容没变，去重
});

it("subscribes presence before querying and marks/clears the restore flag on real transitions only", async () => {
  const registration = deferred<()=>void>(), query = deferred<any>();
  vi.mocked(listen).mockImplementationOnce(async (name,handler) => {handlers[name]=handler; return registration.promise;});
  vi.mocked(invoke).mockReturnValue(query.promise);
  const off = vi.fn();
  const view = renderHook(() => useTeamWindowPresence());
  expect(view.result.current).toBe(false); expect(invoke).not.toHaveBeenCalled();
  await act(async()=>registration.resolve(off));
  expect(invoke).toHaveBeenCalledWith("team_window_exists");
  expect(shouldRestoreTeamWindow()).toBe(false);
  act(()=>handlers["team:presence"]({payload:true}));
  expect(view.result.current).toBe(true); expect(shouldRestoreTeamWindow()).toBe(true);
  // 初始查询结果（已被真实事件抢先）既不改变状态也不该再动一次 localStorage 标记
  await act(async()=>query.resolve(false));
  expect(view.result.current).toBe(true);
  act(()=>handlers["team:presence"]({payload:false}));
  expect(view.result.current).toBe(false); expect(shouldRestoreTeamWindow()).toBe(false);
  view.unmount(); expect(off).toHaveBeenCalledTimes(1);
});

it("never includes password, key path or auth method when the panel publishes its server list", async () => {
  vi.useFakeTimers();
  serviceRoster([member]);
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server, servers:[server], onOpen:vi.fn()}} teamWindowHost/>);
  await act(async()=>{}); await act(async()=>vi.advanceTimersByTimeAsync(300));
  const publish = vi.mocked(invoke).mock.calls.find(([cmd])=>cmd==="team_publish_snapshot");
  expect(publish).toBeTruthy();
  const sent = (publish![1] as {snapshot:TeamWindowSnapshot}).snapshot;
  expect(sent.servers).toEqual([{id:server.id, name:server.name, host:server.host, port:server.port, username:server.username}]);
  expect(JSON.stringify(sent.servers)).not.toMatch(/password|keyPath|authMethod/i);
});

// ── 接收端：useTeamWindowSnapshot（子窗口） ──

it("registers the team:snapshot listener before the first pull and keeps newer broadcasts", async () => {
  const registration = deferred<()=>void>();
  vi.mocked(listen).mockImplementationOnce(async (name,handler) => {handlers[name]=handler; return registration.promise;});
  const pull = deferred<any>(); vi.mocked(invoke).mockReturnValue(pull.promise);
  const view = renderHook(() => useTeamWindowSnapshot());
  expect(invoke).not.toHaveBeenCalled();
  expect(listen).toHaveBeenCalledWith("team:snapshot", expect.any(Function), {target:{kind:"WebviewWindow", label:"team"}});
  const off = vi.fn(); await act(async()=>registration.resolve(off));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("team_request_snapshot"));
  act(()=>handlers["team:snapshot"]({payload:envelope(4)}));
  await act(async()=>pull.resolve({snapshot:envelope(1)}));
  expect(view.result.current.snapshot?.sessionId).toBe("ssh");
  act(()=>handlers["team:snapshot"]({payload:envelope(3)}));   // 旧序号被忽略
  expect(view.result.current.error).toBe("");
  view.unmount(); expect(off).toHaveBeenCalledTimes(1);
});

// ── 动作：TeamWindow 发出 team_window_action，主侧 useTeamWindowActions 路由 ──

it("sends team_window_action({kind:open_member}) from the standalone window's open button", async () => {
  vi.mocked(invoke).mockImplementation(async (command: string) => {
    if (command === "team_request_snapshot") return {snapshot: envelope(1)};
    return undefined;
  });
  render(<TeamWindow/>);
  const button = await screen.findByRole("button", {name:"打开 · worker"});
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("team_window_action", {action:{kind:"open_member", key:"worker@example.test"}}));
});

it("routes team:action events to the right handler for open_member, open_task and refresh", async () => {
  const onOpen = vi.fn().mockResolvedValue(undefined);
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server, servers:[server], onOpen}}
    onOpenTaskDetail={vi.fn()} teamWindowHost/>);
  await waitFor(() => expect(listen).toHaveBeenCalledWith("team:action", expect.any(Function), {target:{kind:"WebviewWindow", label:"main"}}));
  act(()=>handlers["team:action"]({payload:{kind:"open_member", key:"worker@example.test"}}));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(member, server));
  act(()=>handlers["team:action"]({payload:{kind:"refresh"}}));
  await waitFor(() => expect(refreshTeamServiceMock).toHaveBeenCalledWith("demo"));
});

it("routes an open_task action to the panel's own task-detail handler", async () => {
  const onOpenTaskDetail = vi.fn();
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server, servers:[server], onOpen:vi.fn()}}
    onOpenTaskDetail={onOpenTaskDetail} teamWindowHost/>);
  await waitFor(() => expect(listen).toHaveBeenCalledWith("team:action", expect.any(Function), {target:{kind:"WebviewWindow", label:"main"}}));
  act(()=>handlers["team:action"]({payload:{kind:"open_task", project:"demo", code:"T1"}}));
  expect(onOpenTaskDetail).toHaveBeenCalledWith("demo", "T1");
});

it.each([undefined, false])("never calls team window commands from a non-host TeamMembers instance (teamWindowHost=%s)", async (teamWindowHost) => {
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server, servers:[server], onOpen:vi.fn()}} teamWindowHost={teamWindowHost}/>);
  await act(async()=>{});
  expect(screen.queryByRole("button", {name:"在新窗口打开团队面板"})).toBeNull();
  expect(invoke).not.toHaveBeenCalledWith("team_window_exists");
  expect(listen).not.toHaveBeenCalledWith("team:action", expect.any(Function), expect.anything());
});

it("useTeamWindowActions dispatches to the latest handler without re-subscribing", async () => {
  const first = vi.fn(), second = vi.fn();
  const view = renderHook(({handler}) => useTeamWindowActions(handler), {initialProps:{handler:first}});
  await act(async()=>{});
  view.rerender({handler:second});
  act(()=>handlers["team:action"]({payload:{kind:"refresh"}}));
  expect(first).not.toHaveBeenCalled(); expect(second).toHaveBeenCalledWith({kind:"refresh"});
  expect(listen).toHaveBeenCalledTimes(1);
  view.unmount(); expect(offs["team:action"]).toHaveBeenCalledTimes(1);
});

it("sendTeamWindowAction invokes team_window_action with the given action", async () => {
  await sendTeamWindowAction({kind:"refresh"});
  expect(invoke).toHaveBeenCalledWith("team_window_action", {action:{kind:"refresh"}});
});

it("the popout team window has no add-member button (roster edits stay in the main window)",async()=>{
  const {render,screen}=await import("@testing-library/react");
  const TeamDynamics=(await import("../src/components/TeamDynamics")).default;
  const {emptyProfile}=await import("../src/lib/collaboration");
  const server={id:"s",name:"s",host:"h",port:22,username:"u",authMethod:"password" as const};
  const props={sessionId:"ssh",profile:{...emptyProfile(),project:"demo"},navigation:{server,servers:[server],onOpen:vi.fn()},members:[],onUpdated:vi.fn(),
    live:{tasks:[],taskProjects:[],parentBy:{},briefs:{},statusNames:{},offline:false,error:""} as never,serviceLive:{}};
  const {unmount}=render(<TeamDynamics {...props}/>);
  expect(screen.queryByRole("button",{name:/添加成员/})).toBeNull();
  unmount();
  render(<TeamDynamics {...props} onAddMember={vi.fn()}/>);
  expect(screen.getByRole("button",{name:/添加成员/})).toBeTruthy();
});
