import {fireEvent,render,screen,within,waitFor} from "@testing-library/react";
import {expect,it,vi} from "vitest";
import TeamDynamics from "../src/components/TeamDynamics";
import {parseAgentSessions,type LiveSessions,briefKey} from "../src/lib/agentSessions";
import {teamPanelStatus,memberDoingTaskFromIndex} from "../src/lib/teamPanelStatus";
import {emptyProfile} from "../src/lib/collaboration";
import type {TeamMember} from "../src/lib/teamMembers";
import type {ServerEntry} from "../src/types";
const office=vi.hoisted(()=>({render:vi.fn()}));
vi.mock("../src/components/TeamOffice",()=>({default:(props:unknown)=>{office.render(props);return <div>office</div>;}}));
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:transport.invoke}));
import {boardSource,clearBoardCache,defaultLookupSettings} from "../src/lib/taskLookup";
const server:ServerEntry={id:"s",name:"Server",host:"example.test",port:22,username:"dev",authMethod:"password"};
const member=(name:string,role="worker",currentTask="空闲"):TeamMember=>({project:"demo",email:name+"@example.test",role,host:server.host,port:22,username:"dev",workdir:"/repo",tmux:{id:"$"+name,created:1,name:"worker-"+name},currentTask});
const worker=member("worker-a");const lead=member("lead-a","Lead");
const makeLive=(offline=false):LiveSessions=>({snapshot:parseAgentSessions({sessions:[{host:server.host,session:worker.tmux.name,box:"worker-a",project:"demo",state:"idle",lease_status:offline?"unknown":"expired",collector_last_report_at:100,task_code:"T13",task_status:"doing"}],now:200,last_collected_at:100,collector_offline:offline}),tasks:[{project:"demo",code:"T13",title:"Task",status_key:"doing",assignee:"worker-a",updated_at:""}],taskProjects:["demo"],briefs:{},statusNames:{},offline:false,error:""});
const base={rank:7,tone:"idle" as const,group:"available" as const,label:"空闲·可派活",needsHuman:false,duration:""};
const props=(members:TeamMember[],live=makeLive())=>({sessionId:"ssh",profile:{...emptyProfile(),project:"demo"},navigation:{server,servers:[server],onOpen:vi.fn()},members,live,serviceLive:Object.fromEntries(members.map(m=>[m.email,{match:"matched",state:"idle",stale:false}])),onUpdated:vi.fn()});

it("T13 doing owner stays working with expired lease and idle terminal",()=>{
 render(<TeamDynamics {...props([worker])}/>);
 expect(screen.getByText("工作中")).toBeTruthy();
 expect(screen.getByRole("button",{name:"0 可派活"})).toBeTruthy();
 expect(screen.queryByText("空闲·可派活")).toBeNull();
});
it("T13 offline stays explicit, including without a matched session",()=>{
 const live=makeLive(true);live.snapshot!.sessions=[];
 render(<TeamDynamics {...props([worker,member("free")],live)}/>);
 expect(screen.getByText("工作中 · 采集离线")).toBeTruthy();
 expect(screen.getByText("采集离线")).toBeTruthy();
 expect(screen.getByRole("button",{name:"0 可派活"})).toBeTruthy();
});
it("T13 manual working overrides stale/done data; availability needs idle roster and known task index",()=>{
 const live=makeLive();live.tasks=[];
 expect(teamPanelStatus({...worker,currentTask:"工作中·demo/T13"},base,undefined,live).label).toBe("工作中");
 expect(teamPanelStatus(worker,base,undefined,live).group).toBe("available");
 expect(teamPanelStatus({...worker,currentTask:"待确认"},base,undefined,live).group).toBe("other");
 expect(teamPanelStatus(worker,base,undefined,{...live,taskProjects:[]}).group).toBe("other");
 expect(teamPanelStatus(lead,base,undefined,live,true).label).not.toContain("可派活");
 expect(teamPanelStatus(worker,base,undefined,{...live,tasks:[{...makeLive().tasks![0],assignee:"another"}]}).group).toBe("available");
});
it("T14 excludes all Leads from rows and counts, with at most one minimal working shortcut",async()=>{
 const p=props([worker,lead,member("lead-b","Lead","工作中·demo/T99")]);
 const {container}=render(<TeamDynamics {...p} serviceAi={{[lead.email]:{summary:"Lead-only summary"}}}/>);
 expect(container.querySelectorAll(".team-live-row")).toHaveLength(1);
 expect(container.querySelector(".team-live-group-lead")).toBeNull();
 expect(container.querySelectorAll(".team-lead-entry")).toHaveLength(1);
 const entry=screen.getByRole("button",{name:/打开 Lead/});
 expect(entry.textContent).not.toMatch(/T99|空闲|卡住|摘要/);
 expect(entry.querySelectorAll(".team-live-dot")).toHaveLength(1);
 expect(within(screen.getByRole("group",{name:"团队汇总"})).getAllByRole("button").map(e=>e.getAttribute("aria-label"))).toEqual(["0 需要处理","0 等 Lead","0 可派活"]);
 fireEvent.click(entry);await waitFor(()=>expect(p.navigation.onOpen).toHaveBeenCalledWith(lead,server));
});
it("T14 keeps the original office snapshot, including Lead seats",()=>{
 const snapshot={projects:[{id:"demo",sources:[{members:[lead,worker]}]}]} as never;
 render(<TeamDynamics {...props([lead,worker])} officeSnapshot={snapshot}/>);
 fireEvent.click(screen.getByRole("button",{name:"房间"}));
 expect(office.render).toHaveBeenLastCalledWith(expect.objectContaining({snapshot}));
});

it("T13 fetches actual doing ownership even when the collector has no bound card",async()=>{
 clearBoardCache();
 const source=boardSource({...defaultLookupSettings(),boardUrl:"http://board.example.test"})!;
 transport.invoke.mockImplementation(async(_cmd:string,args:{path:string})=>({status:200,body:JSON.stringify(args.path==="/api/v1/projects"?{projects:[{slug:"demo",name:"Demo",parent:""}]}:args.path==="/api/v1/agent-sessions"?{sessions:[],collector_offline:true,last_collected_at:100}:args.path.endsWith("/tasks")?{tasks:makeLive().tasks}:{} )}));
 const p=props([worker]);
 render(<TeamDynamics {...p} live={undefined} board={source}/>);
 await screen.findByText("工作中 · 采集离线");
 expect(transport.invoke).toHaveBeenCalledWith("taskboard_get",expect.objectContaining({path:"/api/v1/projects/demo/tasks"}));
 expect(screen.getByRole("button",{name:"0 可派活"})).toBeTruthy();
 const parsed=parseAgentSessions({sessions:[{session:"x",lease_status:"unknown",collector_last_report_at:123}],collector_offline:true,last_collected_at:123});
 expect(parsed).toMatchObject({collectorOffline:true,collectedAt:123,sessions:[{leaseStatus:"unknown",collectorLastReportAt:123}]});
});
it("T15 treats doing cards in child board projects as working for parent roster members",()=>{
 const parentWorker={...worker,project:"dcollab",email:"dcollab-cw1-codex@example.test",tmux:{...worker.tmux,name:"worker-dcollab-cw1-codex"}};
 const live={...makeLive(),tasks:[{project:"dssh",code:"T15",title:"子项目卡",status_key:"doing",assignee:"dcollab-cw1-codex",updated_at:""}],taskProjects:["dcollab","dssh"],parentBy:{dssh:"dcollab"},
   briefs:{[briefKey("dssh","T15")]:{code:"T15",title:"子项目卡",brief:""}}};
 const baseProps=props([parentWorker],live);
 render(<TeamDynamics {...baseProps} serviceLive={undefined}/>);
 expect(screen.getByText("工作中")).toBeTruthy();
 expect(memberDoingTaskFromIndex(parentWorker, live)).toEqual({ project: "dssh", code: "T15" });
});
