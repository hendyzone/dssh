import {act,renderHook,waitFor} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {buildOfficeSnapshot} from "../src/lib/teamOffice";
vi.mock("../src/lib/teamOffice",async original=>{const actual=await original<any>();return {...actual,buildOfficeSnapshot:vi.fn(actual.buildOfficeSnapshot)}});
const service=vi.hoisted(()=>({current:{} as any}));
vi.mock("../src/lib/teamService",()=>({useTeamService:()=>service.current}));
import {useTeamOffice} from "../src/lib/useTeamOffice";
import {collaborationRequest,emptyProfile} from "../src/lib/collaboration";
import {fetchAgentSessions,parseAgentSessions,taskBrief} from "../src/lib/agentSessions";
import {boardSource} from "../src/lib/taskLookup";
vi.mock("../src/lib/collaboration",async original=>({...await original<any>(),collaborationRequest:vi.fn()}));
vi.mock("../src/lib/agentSessions",async original=>({...await original<any>(),fetchAgentSessions:vi.fn(),taskBrief:vi.fn()}));
vi.mock("../src/lib/taskLookup",async original=>({...await original<any>(),boardSource:vi.fn()}));
const member={project:"alpha",email:"worker@example.invalid",role:"Worker",host:"host.example.invalid",port:22,username:"dev",workdir:"/repo",tmux:{id:"$2",created:123,name:"worker"},currentTask:"manual"};
const options=()=>({enabled:true,profiles:{},servers:[],sessions:[],programSnapshots:{},lookupSettings:{} as any,themeId:"one-light",animationEnabled:true});
const report=(match="exact",state="running")=>({key:member.email,match,state,detail:"",since:"2026-01-01T00:00:00Z",stale:false});
const currentSource=(view:any)=>view.result.current.projects[0].sources[0];
beforeEach(()=>{
 service.current={url:"https://team.example.invalid",projects:["alpha"],status:{state:"online",token_configured:true},snapshots:{alpha:{project:"alpha",identity:"service-alpha",seq:1,members:[member],live:{[member.email]:report()},ai:{},machines:{},receivedAt:1767225600000,offline:false,status:"online"}}};
 vi.mocked(collaborationRequest).mockReset();vi.mocked(buildOfficeSnapshot).mockClear();vi.mocked(boardSource).mockReset().mockReturnValue(undefined);vi.mocked(fetchAgentSessions).mockReset();vi.mocked(taskBrief).mockReset();
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()});
it("renders service members without profiles, SSH connections or remote roster reads",()=>{
 const view=renderHook(()=>useTeamOffice(options()));
 expect(currentSource(view).members[0].name).toBe("worker");
 expect(currentSource(view).availability).toBe("ready");
 expect(collaborationRequest).not.toHaveBeenCalled();
});
it("does not invent a team when the service is unconfigured",()=>{
 service.current={...service.current,url:"",projects:[],snapshots:{}};
 const view=renderHook(()=>useTeamOffice(options()));
 expect(view.result.current.projects).toEqual([]);expect(collaborationRequest).not.toHaveBeenCalled();
});
it("uses URL plus project as identity independently of terminal routes",()=>{
 const view=renderHook(()=>useTeamOffice(options()));const first=currentSource(view).id;const projectId=view.result.current.projects[0].id;
 service.current={...service.current,url:"https://other.example.invalid"};view.rerender();
 expect(currentSource(view).id).not.toBe(first);expect(view.result.current.projects[0].id).not.toBe(projectId);
 expect(collaborationRequest).not.toHaveBeenCalled();
});
it("retains cached offline members and the known data time",()=>{
 service.current.status.state="offline";
 const view=renderHook(()=>useTeamOffice(options()));
 expect(currentSource(view).members).toHaveLength(1);
 expect(currentSource(view).notice).toContain("团队服务离线 · 数据截至");
 expect(currentSource(view).availability).toBe("offline");
});
it("does not assign the current time to an old cache with no timestamp",()=>{
 service.current.status.state="offline";service.current.snapshots.alpha.receivedAt=null;
 const view=renderHook(()=>useTeamOffice(options()));expect(currentSource(view).notice).toBe("团队服务离线 · 数据时间未知");
});
it("renders unauthorized guidance with the retained roster",()=>{
 service.current.status.state="unauthorized";
 const view=renderHook(()=>useTeamOffice(options()));expect(currentSource(view).notice).toContain("令牌已失效");expect(currentSource(view).members).toHaveLength(1);
});
it.each(["exact","replaced","gone"])("service %s prevents contradictory collector status from overriding the room",async match=>{
 service.current.snapshots.alpha.live[member.email]=report(match,"idle");
 vi.mocked(boardSource).mockReturnValue({key:"board",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockResolvedValue(parseAgentSessions({sessions:[{host:member.host,session:"worker",box:member.email,state:"running",project:"alpha",host_ok:true,stale:false}]}));
 const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(fetchAgentSessions).toHaveBeenCalled());
 expect(currentSource(view).members[0].status.state).toBe(match==="gone"?"unknown":"idle");
});
it("no_agent alone falls back to collector data through the production hook",async()=>{
 service.current.snapshots.alpha.live[member.email]=report("no_agent","unknown");
 vi.mocked(boardSource).mockReturnValue({key:"board",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockResolvedValue(parseAgentSessions({sessions:[{host:member.host,session:"worker",box:member.email,state:"running",project:"alpha",host_ok:true,stale:false}]}));
 const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(currentSource(view).members[0].status.state).toBe("working"));
 expect(currentSource(view).members[0].status.label).toContain("看板状态");
});
it("does no snapshot build or board work when cold and inactive",()=>{
 const stringify=vi.spyOn(JSON,"stringify");stringify.mockClear();
 const view=renderHook(()=>useTeamOffice({...options(),enabled:false}));
 expect(stringify).not.toHaveBeenCalled();expect(buildOfficeSnapshot).not.toHaveBeenCalled();expect(fetchAgentSessions).not.toHaveBeenCalled();expect(view.result.current.projects).toEqual([]);
});
it("retains the last snapshot while inactive and updates child theme without collecting",()=>{
 let opts={...options(),officeExists:false};const view=renderHook(()=>useTeamOffice(opts));const first=view.result.current;
 opts={...opts,enabled:false};view.rerender();expect(view.result.current).toBe(first);
 opts={...opts,officeExists:true,themeId:"one-dark"};view.rerender();expect(view.result.current.themeId).toBe("one-dark");expect(fetchAgentSessions).not.toHaveBeenCalled();
});
it("keeps equal snapshots referentially stable and mailbox addresses main-only",()=>{
 const directory={current:new Map()};const view=renderHook(()=>useTeamOffice({...options(),mailDirectoryRef:directory}));const first=view.result.current;
 view.rerender();expect(view.result.current).toBe(first);expect(directory.current.get(member.email)).toHaveLength(1);
 expect(JSON.stringify(first)).not.toContain(member.email);
});
it("stops its optional enrichment timer and ignores late board results when hidden",async()=>{
 vi.useFakeTimers();let resolve:any;vi.mocked(boardSource).mockReturnValue({key:"board",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockImplementation(()=>new Promise(done=>{resolve=done}));
 let enabled=true;const view=renderHook(()=>useTeamOffice({...options(),enabled}));expect(fetchAgentSessions).toHaveBeenCalledTimes(1);
 enabled=false;view.rerender();const last=view.result.current;
 await act(async()=>{resolve(parseAgentSessions({sessions:[]}));await vi.advanceTimersByTimeAsync(120_000)});
 expect(fetchAgentSessions).toHaveBeenCalledTimes(1);expect(view.result.current).toBe(last);
});
it("deduplicates task enrichment for projects sharing a board route",async()=>{
 service.current.projects.push("beta");service.current.snapshots.beta={...service.current.snapshots.alpha,project:"beta",members:[{...member,project:"beta"}]};
 vi.mocked(boardSource).mockReturnValue({key:"shared",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockResolvedValue(parseAgentSessions({sessions:[]}));
 const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(fetchAgentSessions).toHaveBeenCalledTimes(1));
 expect(view.result.current.projects).toHaveLength(2);
});
it.each([undefined,report("exact","unknown"),report("replaced","unknown"),report("gone","unknown")])("never falls back for missing or authoritative unknown live data",async value=>{
 service.current.snapshots.alpha.live=value?{[member.email]:value}:{};
 vi.mocked(boardSource).mockReturnValue({key:"board",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockResolvedValue(parseAgentSessions({sessions:[{host:member.host,session:"worker",box:member.email,state:"running",project:"alpha",host_ok:true,stale:false}]}));
 const view=renderHook(()=>useTeamOffice(options()));await waitFor(()=>expect(fetchAgentSessions).toHaveBeenCalled());
 expect(currentSource(view).members[0].status.state).toBe("unknown");
});
it("uses a bound collector task and its title in the service office nameplate",async()=>{
 vi.mocked(boardSource).mockReturnValue({key:"board",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockResolvedValue(parseAgentSessions({sessions:[{host:member.host,session:member.tmux.name,project:"beta",task_code:"T8",host_ok:true,state:"running"}]}));
 vi.mocked(taskBrief).mockResolvedValue({code:"T8",title:"Bound task title",brief:"Different brief"});
 const view=renderHook(()=>useTeamOffice(options()));
 await waitFor(()=>expect(currentSource(view).members[0].taskFull).toBe("T8 · Bound task title"));
 expect(taskBrief).toHaveBeenCalledWith(expect.anything(),"beta","T8");
});
it("queries the roster task title even if the collector is unavailable",async()=>{
 service.current.snapshots.alpha.members=[{...member,currentTask:"工作中·beta/T9"}];
 vi.mocked(boardSource).mockReturnValue({key:"board",route:{kind:"direct",url:"https://board.example.invalid"}} as any);
 vi.mocked(fetchAgentSessions).mockRejectedValue(new Error("offline"));
 vi.mocked(taskBrief).mockResolvedValue({code:"T9",title:"Roster task title",brief:""});
 const view=renderHook(()=>useTeamOffice(options()));
 await waitFor(()=>expect(currentSource(view).members[0].taskFull).toBe("T9 · Roster task title"));
});

it("drops old board titles immediately when switching the board route",async()=>{
 const a={key:"board-a",route:{kind:"direct",url:"https://board-a.example.invalid"}};
 const b={key:"board-b",route:{kind:"direct",url:"https://board-b.example.invalid"}};
 const sessions=parseAgentSessions({sessions:[{host:member.host,session:member.tmux.name,project:"alpha",task_code:"T1",state:"running"}]});
 vi.mocked(boardSource).mockReturnValue(a as any);vi.mocked(fetchAgentSessions).mockResolvedValue(sessions);
 vi.mocked(taskBrief).mockResolvedValue({code:"T1",title:"Board A title",brief:""});
 let settings={boardUrl:"https://board-a.example.invalid"} as any;
 const view=renderHook(()=>useTeamOffice({...options(),lookupSettings:settings}));
 await waitFor(()=>expect(currentSource(view).members[0].taskFull).toBe("T1 · Board A title"));
 let resolve!:(value:any)=>void;vi.mocked(fetchAgentSessions).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 vi.mocked(boardSource).mockReturnValue(b as any);vi.mocked(taskBrief).mockResolvedValue({code:"T1",title:"Board B title",brief:""});
 settings={boardUrl:"https://board-b.example.invalid"};view.rerender();
 expect(currentSource(view).members[0].taskFull).not.toContain("Board A title");
 await act(async()=>resolve(sessions));
 await waitFor(()=>expect(currentSource(view).members[0].taskFull).toBe("T1 · Board B title"));
});
