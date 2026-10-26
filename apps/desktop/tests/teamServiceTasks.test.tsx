import {render,screen,fireEvent,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import TeamDynamics from "../src/components/TeamDynamics";
import {serviceMemberState,memberTaskTarget,memberTaskSession} from "../src/lib/teamServicePresentation";
import {taskBrief,parseAgentSessions} from "../src/lib/agentSessions";
import {loadCard} from "../src/lib/taskLookup";
import {emptyProfile} from "../src/lib/collaboration";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("../src/lib/agentSessions",async original=>({...await original<any>(),taskBrief:vi.fn()}));
vi.mock("../src/lib/taskLookup",async original=>({...await original<any>(),loadCard:vi.fn()}));
const member={project:"alpha",email:"worker@example.invalid",role:"Worker",host:"host.example.invalid",port:22,username:"dev",workdir:"/repo",tmux:{id:"$1",created:1,name:"worker"},currentTask:"工作中·beta/T8"};
const server={id:"host",name:"Example",host:member.host,port:22,username:"dev",authMethod:"password" as const};
const report={key:member.email,match:"exact" as const,state:"running" as const,detail:"",branch:"task/alpha-T7"};
const board={key:"board",webUrl:"https://board.example.invalid",route:{kind:"direct" as const,url:"https://board.example.invalid"}};
const bound=parseAgentSessions({sessions:[{host:member.host,session:member.tmux.name,project:"alpha",task_code:"T7",host_ok:true,state:"running",worktree:"/repo"}]}).sessions[0];
const live={snapshot:{sessions:[bound],now:1,ttlSeconds:180,alertAfterSeconds:600,collectedAt:1},briefs:{},statusNames:{},offline:false,error:""};
const props=(extra:any={})=>({sessionId:"",profile:{...emptyProfile(),project:"alpha"},navigation:{server,servers:[server],onOpen:vi.fn()},members:[member],onUpdated:vi.fn(),board,live,serviceLive:{[member.email]:report},serviceIdentity:"https://team.example.invalid/alpha",...extra});
beforeEach(()=>{vi.mocked(taskBrief).mockReset().mockImplementation(async(_source,project,code)=>({code,title:project+" task title",brief:"Focused task brief"}));vi.mocked(loadCard).mockReset().mockResolvedValue({project:"alpha",task:{code:"T7",title:"Full task title",status_key:"doing",assignee:"",updated_at:"",status_changed_at:"",summary:"",acceptance:""},slugs:[],dependencies:[],dependents:[]} as any);});
it("maps service branch and collector-bound project-qualified task, falling back only to a valid roster task",()=>{
 expect(serviceMemberState(member,report,bound)).toMatchObject({branch:"task/alpha-T7",project:"alpha",taskCode:"T7"});
 expect(serviceMemberState(member,{...report,branch:undefined})).toMatchObject({branch:"",project:"beta",taskCode:"T8"});
 expect(memberTaskTarget({...member,currentTask:"arbitrary private note"})).toBeUndefined();
});
it("shows a service task brief and opens the existing task card on click",async()=>{
 render(<TeamDynamics {...props()}/>);
 const button=await screen.findByRole("button",{name:"T7 · alpha task title"});
 expect(taskBrief).toHaveBeenCalledWith(expect.objectContaining({route:board.route}),"alpha","T7");
 fireEvent.click(button);expect(await screen.findByRole("article",{name:"任务 T7"})).toBeTruthy();
 expect(loadCard).toHaveBeenCalledWith(board,"alpha","T7");expect(screen.getByText("Full task title")).toBeTruthy();
});
it("shows a compact Lead task and roster fallback, with code alone when the brief is unavailable",async()=>{
 vi.mocked(taskBrief).mockResolvedValue(null);
 render(<TeamDynamics {...props({members:[{...member,role:"Lead"}],serviceLive:{[member.email]:{...report,branch:undefined}},live:{...live,snapshot:undefined}})}/>);
 const button=await screen.findByRole("button",{name:"T8"});expect(button).toBeTruthy();
 await waitFor(()=>expect(taskBrief).toHaveBeenCalledWith(expect.objectContaining({route:board.route}),"beta","T8"));
});
it("omits the task line when neither service nor roster identifies a task",()=>{
 render(<TeamDynamics {...props({members:[{...member,currentTask:""}],serviceLive:{[member.email]:report},live:{...live,snapshot:undefined}})}/>);
 expect(document.querySelector('.team-task-link')).toBeNull();
});
it("discards a previous service's late title response",async()=>{
 let resolve!:(value:any)=>void;vi.mocked(taskBrief).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 const view=render(<TeamDynamics {...props()}/>);
 view.rerender(<TeamDynamics {...props({serviceIdentity:"https://other.example.invalid/alpha",live:{...live,snapshot:{...live.snapshot,sessions:[{...bound,taskCode:"T9"}]}}})}/>);
 await screen.findByRole("button",{name:"T9 · alpha task title"});resolve({code:"T7",title:"Old private title",brief:""});
 await waitFor(()=>expect(document.body.textContent).not.toContain("Old private title"));
});

it("requires a unique host and tmux name for collector task binding",()=>{
 expect(memberTaskSession(member,[{...bound,host:"other.example.invalid"}])).toBeUndefined();
 expect(memberTaskSession(member,[{...bound,session:"other"}])).toBeUndefined();
 expect(memberTaskSession(member,[bound,{...bound,project:"beta"}])).toBeUndefined();
 expect(memberTaskSession(member,[bound])).toBe(bound);
});
it("uses roster tasks for no_agent without inventing live status",async()=>{
 render(<TeamDynamics {...props({serviceLive:{[member.email]:{...report,match:"no_agent"}},live:{...live,snapshot:undefined}})}/>);
 expect(await screen.findByRole("button",{name:"T8 · beta task title"})).toBeTruthy();
});

it("never derives a card number from branch and rejects stale collector bindings",()=>{
 expect(memberTaskTarget({...member,currentTask:""},{...bound,taskCode:""})).toBeUndefined();
 expect(serviceMemberState({...member,currentTask:""},report)).toMatchObject({taskCode:"",branch:"task/alpha-T7"});
 expect(memberTaskTarget(member,{...bound,stale:true})).toEqual({project:"beta",code:"T8",manual:true});
});
it("does not show a previous board's late title after the route changes",async()=>{
 let resolve!:(value:any)=>void;vi.mocked(taskBrief).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
 const view=render(<TeamDynamics {...props()}/>);
 view.rerender(<TeamDynamics {...props({board:{...board,key:"other-board",webUrl:"https://other-board.example.invalid"}})}/>);
 await screen.findByRole("button",{name:"T7 · alpha task title"});resolve({code:"T7",title:"Old board title",brief:""});
 await waitFor(()=>expect(document.body.textContent).not.toContain("Old board title"));
});
