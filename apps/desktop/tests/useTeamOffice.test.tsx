import {act,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {buildOfficeSnapshot} from "../src/lib/teamOffice";
vi.mock("../src/lib/teamOffice",async original=>{const actual=await original<any>();return {...actual,buildOfficeSnapshot:vi.fn(actual.buildOfficeSnapshot)}});
import {useTeamOffice} from "../src/lib/useTeamOffice";
import {collaborationRequest,collaborationKey,emptyProfile} from "../src/lib/collaboration";
import {fetchAgentSessions,parseAgentSessions,taskBrief} from "../src/lib/agentSessions";
import {boardSource} from "../src/lib/taskLookup";
vi.mock("../src/lib/collaboration",async original=>({...await original<any>(),collaborationRequest:vi.fn()}));
vi.mock("../src/lib/agentSessions",async original=>({...await original<any>(),fetchAgentSessions:vi.fn(),taskBrief:vi.fn()}));
vi.mock("../src/lib/taskLookup",async original=>({...await original<any>(),boardSource:vi.fn()}));
const server={id:"remote",name:"Remote",host:"example.test",port:22,username:"dev",authMethod:"password" as const};
const profile={...emptyProfile(),enabled:true,membersEnabled:true,project:"alpha",workdir:"/repo",tmuxId:"$1",tmuxCreated:100,tmuxName:"lead"};
const member={project:"alpha",email:"worker@example.test",role:"Worker",host:server.host,port:22,username:"dev",workdir:"/repo",tmux:{id:"$2",created:123,name:"worker"},currentTask:"manual"};
const options=()=>({enabled:true,profiles:{[collaborationKey(server.id,profile)]:profile},servers:[server],sessions:[{pane:{id:"pane",server,tmux:{id:"$1",created:100,name:"lead"}},backendId:"ssh"}],programSnapshots:{},lookupSettings:{} as any,themeId:"one-light",animationEnabled:true});
beforeEach(()=>{vi.mocked(collaborationRequest).mockReset().mockResolvedValue(JSON.stringify([member]));vi.mocked(boardSource).mockReset().mockReturnValue(undefined);vi.mocked(fetchAgentSessions).mockReset();vi.mocked(taskBrief).mockReset();});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()});
it("reads only registered reachable rosters via existing members operation and never mailctl",async()=>{
 const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(view.result.current.projects[0].sources[0].availability).toBe("ready"));
 expect(collaborationRequest).toHaveBeenCalledTimes(1);expect(collaborationRequest).toHaveBeenCalledWith("ssh",profile,{operation:"members"});expect(view.result.current.mailAvailability).toBe("unavailable");
 view.unmount();
});
it("does not read unavailable teams and does not fabricate empty successful data",async()=>{
 const opts=options();opts.sessions=[];const view=renderHook(()=>useTeamOffice(opts));expect(view.result.current.projects[0].sources[0].availability).toBe("offline");expect(collaborationRequest).not.toHaveBeenCalled();
});
it("drops a stale roster response after the registered source switches",async()=>{
 let finish!:(value:string)=>void;vi.mocked(collaborationRequest).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));
 const first=options();const view=renderHook(({opts})=>useTeamOffice(opts),{initialProps:{opts:first}});
 const replacement={...first,profiles:{}};view.rerender({opts:replacement});await act(async()=>finish(JSON.stringify([member])));expect(view.result.current.projects).toEqual([]);
});
it("deduplicates board source and task reads across distinct team source sections",async()=>{
 const opts=options();const p2={...profile,workdir:"/another",tmuxId:"$3"};opts.profiles[collaborationKey(server.id,p2)]=p2;
 vi.mocked(boardSource).mockReturnValue({key:"shared",url:"https://board.example.test"} as any);
 vi.mocked(fetchAgentSessions).mockResolvedValue(parseAgentSessions({sessions:[{host:server.host,session:"worker",project:"alpha",task_code:"T1",host_ok:true,stale:false}]}));vi.mocked(taskBrief).mockResolvedValue({code:"T1",title:"Current",brief:"Board brief"});
 const view=renderHook(()=>useTeamOffice(opts));await waitFor(()=>expect(view.result.current.projects[0].sources.every(s=>s.members[0]?.taskSource==="board")).toBe(true));
 expect(collaborationRequest).toHaveBeenCalledTimes(2);expect(fetchAgentSessions).toHaveBeenCalledTimes(1);expect(taskBrief).toHaveBeenCalledTimes(1);
 expect(view.result.current.projects[0].sources.map(s=>s.members[0].taskSource)).toEqual(["board","board"]);
});
it("uses one shared refresh timer and cleans it after unmount",async()=>{
 vi.useFakeTimers();const opts=options();const view=renderHook(()=>useTeamOffice(opts));await act(async()=>{});expect(collaborationRequest).toHaveBeenCalledTimes(1);
 await act(async()=>vi.advanceTimersByTimeAsync(60_000));expect(collaborationRequest).toHaveBeenCalledTimes(2);
 view.unmount();await act(async()=>vi.advanceTimersByTimeAsync(120_000));expect(collaborationRequest).toHaveBeenCalledTimes(2);
});
it("reports a malformed roster as unavailable rather than silently dropping its members",async()=>{
 vi.mocked(collaborationRequest).mockResolvedValue('{"not":"a list"}');const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(view.result.current.projects[0].sources[0].availability).toBe("error"));expect(view.result.current.projects[0].sources[0].members).toEqual([]);
});

it("shows a ready roster and manual task while board enrichment is still pending",async()=>{
 let finish!:(value:any)=>void;vi.mocked(boardSource).mockReturnValue({key:"shared",url:"https://board.example.test"} as any);vi.mocked(fetchAgentSessions).mockReturnValue(new Promise(resolve=>{finish=resolve}));
 const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(view.result.current.projects[0].sources[0].availability).toBe("ready"));
 expect(view.result.current.projects[0].sources[0].members[0].taskSource).toBe("manual");
 await act(async()=>finish(parseAgentSessions({sessions:[]})));view.unmount();
});

it("does no roster or board work while disabled and stops refreshing when hidden or closed",async()=>{
 vi.useFakeTimers();const opts=options();const view=renderHook(({enabled})=>useTeamOffice({...opts,enabled}),{initialProps:{enabled:false}});await act(async()=>vi.advanceTimersByTimeAsync(120_000));expect(collaborationRequest).not.toHaveBeenCalled();expect(fetchAgentSessions).not.toHaveBeenCalled();
 view.rerender({enabled:true});await act(async()=>{});expect(collaborationRequest).toHaveBeenCalledTimes(1);view.rerender({enabled:false});await act(async()=>vi.advanceTimersByTimeAsync(120_000));expect(collaborationRequest).toHaveBeenCalledTimes(1);expect(view.result.current.projects[0].sources[0].availability).toBe("ready");
 view.rerender({enabled:true});await act(async()=>{});expect(collaborationRequest).toHaveBeenCalledTimes(2);
});
it("keeps identical snapshots referentially stable across unrelated renders and equal refresh results",async()=>{
 const opts=options();const storage=vi.spyOn(Storage.prototype,"getItem");const view=renderHook(({input})=>useTeamOffice(input),{initialProps:{input:opts}});await waitFor(()=>expect(view.result.current.projects[0].sources[0].availability).toBe("ready"));const initial=view.result.current;const reads=storage.mock.calls.length;
 view.rerender({input:structuredClone(opts)});expect(view.result.current).toBe(initial);expect(storage.mock.calls.length).toBe(reads);
 await act(async()=>window.dispatchEvent(new Event("dssh-office-refresh")));expect(view.result.current).toBe(initial);
});
it("changing one backend only reloads that source while other ready teams keep their cached roster",async()=>{
 const first=options();const otherServer={...server,id:"second",host:"other.test",name:"Second"};const otherProfile={...profile,project:"beta",workdir:"/other"};const secondSession={pane:{id:"second-pane",server:otherServer,tmux:{id:"$1",created:100,name:"lead"}},backendId:"ssh-second"};
 const opts={...first,servers:[server,otherServer],profiles:{...first.profiles,[collaborationKey(otherServer.id,otherProfile)]:otherProfile},sessions:[...first.sessions,secondSession]};
 vi.mocked(collaborationRequest).mockImplementation(async(_id,profile)=>JSON.stringify([{...member,project:profile.project,host:profile.project==="beta"?"other.test":server.host}]));
 const view=renderHook(({input})=>useTeamOffice(input),{initialProps:{input:opts}});await waitFor(()=>expect(view.result.current.projects.every(p=>p.sources[0].availability==="ready")).toBe(true));expect(collaborationRequest).toHaveBeenCalledTimes(2);
 let finish!:(s:string)=>void;vi.mocked(collaborationRequest).mockReturnValueOnce(new Promise(resolve=>{finish=resolve}));const next={...opts,sessions:[{...first.sessions[0],backendId:"ssh-reconnected"},secondSession]};view.rerender({input:next});
 await waitFor(()=>expect(collaborationRequest).toHaveBeenCalledTimes(3));expect(vi.mocked(collaborationRequest).mock.calls[2][0]).toBe("ssh-reconnected");expect(view.result.current.projects.find(p=>p.name==="beta")?.sources[0]).toMatchObject({availability:"ready",members:[{name:"Worker"}]});
 await act(async()=>finish(JSON.stringify([member])));expect(collaborationRequest).toHaveBeenCalledTimes(3);expect(view.result.current.projects.every(p=>p.sources[0].availability==="ready")).toBe(true);
});

it("skips snapshot building and source/snapshot serialization on inactive rerenders, retaining the last snapshot",async()=>{
 const opts=options();const view=renderHook(({enabled,officeExists})=>useTeamOffice({...opts,enabled,officeExists}),{initialProps:{enabled:true,officeExists:false}});await waitFor(()=>expect(view.result.current.projects[0].sources[0].availability).toBe("ready"));
 view.rerender({enabled:false,officeExists:false});const previous=view.result.current;vi.mocked(buildOfficeSnapshot).mockClear();const stringify=vi.spyOn(JSON,"stringify");
 for(let i=0;i<4;i++)view.rerender({enabled:false,officeExists:false});
 expect(buildOfficeSnapshot).not.toHaveBeenCalled();expect(stringify).not.toHaveBeenCalled();expect(view.result.current).toBe(previous);stringify.mockRestore();
});
it("updates cached presentation for an existing child while main is hidden without collecting",async()=>{
 const opts=options();const view=renderHook(({enabled,themeId})=>useTeamOffice({...opts,enabled,officeExists:true,themeId}),{initialProps:{enabled:true,themeId:"one-light"}});await waitFor(()=>expect(view.result.current.projects[0].sources[0].availability).toBe("ready"));
 const calls=vi.mocked(collaborationRequest).mock.calls.length;view.rerender({enabled:false,themeId:"tokyo-night"});expect(view.result.current.themeId).toBe("tokyo-night");expect(view.result.current.projects[0].sources[0].members[0].name).toBe("Worker");expect(collaborationRequest).toHaveBeenCalledTimes(calls);
});
it("retains same-source roster during backend replacement but rejects stale callbacks and distinct source reuse",async()=>{
 const opts=options();const view=renderHook(({input})=>useTeamOffice(input),{initialProps:{input:opts}});await waitFor(()=>expect(view.result.current.projects[0].sources[0].members[0]?.name).toBe("Worker"));
 let oldDone!:(s:string)=>void;vi.mocked(collaborationRequest).mockReturnValueOnce(new Promise(r=>{oldDone=r}));const second={...opts,sessions:[{...opts.sessions[0],backendId:"replacement"}]};view.rerender({input:second});expect(view.result.current.projects[0].sources[0]).toMatchObject({availability:"ready",members:[{name:"Worker"}]});
 let newDone!:(s:string)=>void;vi.mocked(collaborationRequest).mockReturnValueOnce(new Promise(r=>{newDone=r}));const other={...profile,workdir:"/different",project:"other"};const third={...second,profiles:{[collaborationKey(server.id,other)]:other}};view.rerender({input:third});expect(view.result.current.projects[0].sources[0].members).toEqual([]);
 await act(async()=>oldDone(JSON.stringify([{...member,role:"Stale worker"}])));expect(view.result.current.projects[0].sources[0].members).toEqual([]);
 await act(async()=>newDone(JSON.stringify([{...member,project:"other",role:"New worker"}])));expect(view.result.current.projects[0].sources[0].members[0].name).toBe("New worker");
});

it("starts inactive without building or serializing office data",()=>{
 const opts=options();vi.mocked(buildOfficeSnapshot).mockClear();const stringify=vi.spyOn(JSON,"stringify");const view=renderHook(()=>useTeamOffice({...opts,enabled:false,officeExists:false}));
 expect(buildOfficeSnapshot).not.toHaveBeenCalled();expect(stringify).not.toHaveBeenCalled();expect(collaborationRequest).not.toHaveBeenCalled();expect(view.result.current.projects).toEqual([]);view.unmount();stringify.mockRestore();
});
