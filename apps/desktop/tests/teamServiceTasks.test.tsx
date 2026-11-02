import {render,screen,fireEvent,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import TeamDynamics from "../src/components/TeamDynamics";
import {serviceMemberState,memberTaskTarget,memberTaskSession} from "../src/lib/teamServicePresentation";
import {taskBrief,parseAgentSessions} from "../src/lib/agentSessions";
import {emptyProfile} from "../src/lib/collaboration";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("../src/lib/agentSessions",async original=>({...await original<any>(),taskBrief:vi.fn()}));
const member={project:"alpha",email:"worker@example.invalid",role:"Worker",host:"host.example.invalid",port:22,username:"dev",workdir:"/repo",tmux:{id:"$1",created:1,name:"worker"},currentTask:""};
const server={id:"host",name:"Example",host:member.host,port:22,username:"dev",authMethod:"password" as const};
const report={key:member.email,match:"exact" as const,state:"running" as const,detail:"",branch:"task/alpha-T7"};
const board={key:"board",webUrl:"https://board.example.invalid",route:{kind:"direct" as const,url:"https://board.example.invalid"}};
const bound=parseAgentSessions({sessions:[{host:member.host,session:member.tmux.name,project:"alpha",task_code:"T7",host_ok:true,state:"running",worktree:"/repo"}]}).sessions[0];
const doing=(code:string,assignee="worker")=>({project:"alpha",code,title:"标题 "+code,status_key:"doing",assignee,updated_at:""});
const live={snapshot:{sessions:[bound],now:1,ttlSeconds:180,alertAfterSeconds:600,collectedAt:1},tasks:[] as ReturnType<typeof doing>[],taskProjects:["alpha"],briefs:{},statusNames:{},offline:false,error:""};
const props=(extra:any={})=>({sessionId:"",profile:{...emptyProfile(),project:"alpha"},navigation:{server,servers:[server],onOpen:vi.fn()},members:[member],onUpdated:vi.fn(),board,live,serviceLive:{[member.email]:report},serviceIdentity:"https://team.example.invalid/alpha",...extra});
beforeEach(()=>{vi.mocked(taskBrief).mockReset().mockResolvedValue({code:"T7",title:"never shown",brief:""});});

it("T94: the collector binding is the only session card; the hand-written note is never parsed",()=>{
 expect(memberTaskTarget(bound)).toEqual({project:"alpha",code:"T7"});
 expect(memberTaskTarget({...bound,stale:true})).toBeUndefined();
 expect(memberTaskTarget({...bound,taskCode:""})).toBeUndefined();
 expect(memberTaskTarget({...bound,state:"gone"})).toBeUndefined();
 expect(memberTaskTarget()).toBeUndefined();
 expect(serviceMemberState({...member,currentTask:"工作中·beta/T8"},{...report,branch:undefined})).toMatchObject({taskCode:"",branch:""});
 expect(serviceMemberState({...member,currentTask:"空闲"},report,bound)).toMatchObject({project:"alpha",taskCode:"T7"});
});
it("T94: the card badge is the board's doing card and opens it; no brief fetch",async()=>{
 const openDetail=vi.fn();
 render(<TeamDynamics {...props({onOpenTaskDetail:openDetail,live:{...live,tasks:[doing("T12")]}})}/>);
 const button=screen.getByRole("button",{name:/T12/});
 expect(button.textContent).toContain("标题 T12");
 fireEvent.click(button);
 await waitFor(()=>expect(openDetail).toHaveBeenCalledWith("alpha","T12"));
 expect(taskBrief).not.toHaveBeenCalled();
});
it.each(["工作中·beta/T8","beta/T8 进行中","空闲",""])("T94: without a doing card the badge says 无卡, whatever the note says (%j) or the collector binds",currentTask=>{
 const {container}=render(<TeamDynamics {...props({members:[{...member,currentTask}]})}/>);
 expect(container.querySelector(".team-card-badge.is-none")?.textContent).toBe("无卡");
 expect(screen.queryByRole("button",{name:/T8|T7/})).toBeNull();
 expect(taskBrief).not.toHaveBeenCalled();
});
it("T94: no_agent members get no card from the note either",()=>{
 const {container}=render(<TeamDynamics {...props({members:[{...member,currentTask:"工作中·beta/T8"}],serviceLive:{[member.email]:{...report,match:"no_agent"}},live:{...live,snapshot:undefined}})}/>);
 expect(screen.queryByRole("button",{name:/T8/})).toBeNull();
 expect(container.querySelector(".team-card-badge.is-none")).toBeTruthy();
});
it("requires a unique host and tmux name for collector task binding",()=>{
 expect(memberTaskSession(member,[{...bound,host:"other.example.invalid"}])).toBeUndefined();
 expect(memberTaskSession(member,[{...bound,session:"other"}])).toBeUndefined();
 expect(memberTaskSession(member,[bound,{...bound,project:"beta"}])).toBeUndefined();
 expect(memberTaskSession(member,[bound])).toBe(bound);
});
it("does not display or fetch task information for the compact Lead entry",()=>{
 render(<TeamDynamics {...props({members:[{...member,role:"Lead",currentTask:"工作中·beta/T8"}],live:{...live,tasks:[doing("T9")]}})}/>);
 expect(screen.getByRole("button",{name:/打开 Lead/})).toBeTruthy();
 expect(screen.queryByRole("button",{name:/T8|T9/})).toBeNull();
 expect(document.querySelector(".team-live-row")).toBeNull();
 expect(taskBrief).not.toHaveBeenCalled();
});
it("T94: collector mode (no team service) never shows a hand-written 工作中",()=>{
 const noted=[{...member,currentTask:"工作中·beta/T8"},{...member,email:"idle@example.invalid",tmux:{...member.tmux,id:"$2",name:"idle"},currentTask:"空闲"}];
 // Board unreachable: no snapshot, no service. The note stays a note.
 render(<TeamDynamics {...props({members:noted,serviceLive:undefined,live:{...live,snapshot:undefined,offline:true}})}/>);
 expect(screen.queryByText(/^工作中/)).toBeNull();
 expect(screen.queryByText(/（手写）/)).toBeNull();
 expect(screen.getAllByText("状态未知")).toHaveLength(2);
 expect(screen.queryByRole("button",{name:/T8/})).toBeNull();
});
