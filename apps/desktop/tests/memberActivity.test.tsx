import {render,screen,within} from "@testing-library/react";
import {describe,expect,it,vi} from "vitest";
const transport=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:transport.invoke}));
vi.mock("../src/components/TeamOffice",()=>({default:()=><div>office</div>}));
import TeamDynamics from "../src/components/TeamDynamics";
import TeamServiceAi from "../src/components/TeamServiceAi";
import AdventurePanel from "../src/components/AdventurePanel";
import {ACTIVITY_VIEW,activityStatus,aiIsOld,parseActivity,shownActivity,type ActivityState} from "../src/lib/memberActivity";
import {teamPanelStatus} from "../src/lib/teamPanelStatus";
import {buildOfficeSnapshot} from "../src/lib/teamOffice";
import {emptyProfile} from "../src/lib/collaboration";
import {memberKey,type TeamMember} from "../src/lib/teamMembers";
import type {LiveSessions,LiveStatus} from "../src/lib/agentSessions";
import type {ServerEntry} from "../src/types";

const NOW=1_793_600_000;
const iso=(minutesAgo:number)=>new Date((NOW-minutesAgo*60)*1000).toISOString();
const server:ServerEntry={id:"s",name:"Server",host:"example.test",port:22,username:"dev",authMethod:"password"};
const member=(box:string,role="worker"):TeamMember=>({project:"demo",email:box+"@example.test",role,host:server.host,port:22,username:"dev",workdir:"/repo",tmux:{id:"$"+box.length,created:1,name:"worker-"+box}});
const task=(code:string,assignee:string)=>({project:"demo",code,title:"标题 "+code,status_key:"doing",assignee,updated_at:""});
const live=(tasks:ReturnType<typeof task>[]=[]):LiveSessions=>({tasks,taskProjects:["demo"],parentBy:{},briefs:{},statusNames:{},offline:false,error:"",
  snapshot:{sessions:[],now:NOW,collectedAt:NOW,collectorOffline:false} as never});
const base:LiveStatus={rank:6,tone:"run",group:"running",label:"运行中",needsHuman:false,duration:""};
const act=(state:ActivityState,reason="r",since=5)=>({state,reason,since:iso(since),source:"events" as const});

describe("seven activity states",()=>{
  it("the five shown states carry an icon and a word, each different (readable in greyscale)",()=>{
    const labels=Object.values(ACTIVITY_VIEW).map(v=>`${v.icon} ${v.label}`);
    expect(new Set(labels).size).toBe(5);
    expect(new Set(Object.values(ACTIVITY_VIEW).map(v=>v.icon)).size).toBe(5);
    for(const state of ["working","stalled","waiting_human","idle","offline"] as const){
      const status=teamPanelStatus(member("w"),base,undefined,live(),false,act(state));
      expect(status.label.startsWith(ACTIVITY_VIEW[state].icon+" "+ACTIVITY_VIEW[state].label)).toBe(true);
      expect(status.duration).toBe("5 分钟");
      expect(status.title).toBe("r");
    }
  });
  it("unattached and unknown fall back to the pane status",()=>{
    for(const state of ["unattached","unknown"] as const){
      expect(shownActivity(act(state))).toBeUndefined();
      expect(teamPanelStatus(member("w"),base,undefined,live(),false,act(state))).toEqual(base);
    }
  });
  it("parses the wire value and drops malformed activity",()=>{
    expect(parseActivity({state:"waiting_human",reason:"等确认：Bash",since:iso(1),source:"pane",extra:1})).toEqual({state:"waiting_human",reason:"等确认：Bash",since:iso(1),source:"pane"});
    for(const bad of [undefined,null,1712349999,"working",{state:"busy"},{reason:"x"},[]])expect(parseActivity(bad)).toBeUndefined();
    expect(activityStatus({...act("idle"),source:"pane"},false,NOW)?.title).toBe("r · 据面板推断");
  });
});

describe("three combinations that need a look",()=>{
  const card=live([task("T1","w")]);
  it("card + idle, card + stalled and waiting for a person rank first and need a human",()=>{
    const cardIdle=teamPanelStatus(member("w"),base,undefined,card,false,act("idle"));
    const cardStalled=teamPanelStatus(member("w"),base,undefined,card,false,act("stalled"));
    const waiting=teamPanelStatus(member("w"),base,undefined,live(),false,act("waiting_human"));
    const plainIdle=teamPanelStatus(member("w"),base,undefined,live(),false,act("idle"));
    const working=teamPanelStatus(member("w"),base,undefined,card,false,act("working"));
    expect(cardIdle).toMatchObject({group:"attention",needsHuman:true,label:"⏸ 空闲 · 有卡未动"});
    expect(cardStalled).toMatchObject({group:"attention",needsHuman:true,rank:0});
    expect(waiting).toMatchObject({group:"attention",needsHuman:true});
    expect(plainIdle).toMatchObject({group:"available",needsHuman:false});
    expect(working).toMatchObject({group:"running",needsHuman:false});
    const order=[plainIdle,working,cardIdle,waiting,cardStalled].sort((a,b)=>a.rank-b.rank).map(s=>s.label);
    expect(order.slice(0,3)).toEqual([cardStalled.label,waiting.label,cardIdle.label]);
  });
  it("an old service (no activity) still flags card + idle from the pane status",()=>{
    const idle:LiveStatus={rank:7,tone:"idle",group:"available",label:"空闲·可派活",needsHuman:false,duration:""};
    expect(teamPanelStatus(member("w"),idle,undefined,card)).toMatchObject({group:"attention",label:"空闲 · 有卡未动",needsHuman:true});
    expect(teamPanelStatus(member("w"),base,undefined,card)).toEqual(base);
  });
});

describe("team panel row",()=>{
  const props=(members:TeamMember[],serviceLive:Record<string,unknown>,l=live())=>({sessionId:"ssh",profile:{...emptyProfile(),project:"demo"},
    navigation:{server,servers:[server],onOpen:vi.fn()},members,live:l,serviceLive:serviceLive as never,onUpdated:vi.fn()});
  const report=(m:TeamMember,extra:Record<string,unknown>={})=>({key:memberKey(m),match:"exact",state:"running",detail:"",...extra});
  it("shows the card badge and the activity side by side; several cards show the first and a count",()=>{
    const a=member("a"),b=member("b"),c=member("c");
    const {container}=render(<TeamDynamics {...props([a,b,c],{
      [memberKey(a)]:report(a,{activity:act("working","工具 Bash 运行 7 分",7)}),
      [memberKey(b)]:report(b,{activity:act("waiting_human","等确认：Bash",3)}),
      [memberKey(c)]:report(c,{state:"idle"}),
    },live([task("T34","a"),task("T37","b"),task("T38","b")]))}/>);
    const rowOf=(box:string)=>container.querySelector(`[data-member-key="${box}@example.test"]`) as HTMLElement;
    const chipsA=rowOf("a").querySelector(".team-member-chips")!;
    expect(within(chipsA as HTMLElement).getByRole("button",{name:/T34/}).textContent).toContain("标题 T34");
    expect(chipsA.textContent).toContain("▶ 干活中");
    expect(chipsA.querySelector(".team-live-badge")?.getAttribute("title")).toBe("工具 Bash 运行 7 分");
    const chipsB=rowOf("b").querySelector(".team-member-chips")!;
    expect(chipsB.textContent).toContain("T37");
    expect(chipsB.textContent).toContain("⚠ +1");
    expect(chipsB.textContent).toContain("✋ 等人");
    // 旧服务端：没有 activity，退回面板状态；没有卡显示「无卡」。
    const chipsC=rowOf("c").querySelector(".team-member-chips")!;
    expect(chipsC.textContent).toContain("无卡");
    expect(chipsC.textContent).toContain("待确认"); // 原有面板逻辑：名单没写「空闲」
    expect(screen.queryByText("工作中")).toBeNull();
  });
  it("Lead rows carry no card badge",()=>{
    const lead=member("demo-lead","Lead"),w=member("w");
    const {container}=render(<TeamDynamics {...props([lead,w],{[memberKey(lead)]:report(lead,{activity:act("working")}),[memberKey(w)]:report(w)},
      live([task("T9","demo-lead")]))}/>);
    expect(container.textContent).not.toContain("T9");
  });
});

it("office: activity line, doing card with count, Lead without card",()=>{
  const w=member("w"),lead=member("demo-lead","Lead");
  const snapshot=buildOfficeSnapshot([{id:"svc",project:"demo",label:"demo",profile:{...emptyProfile(),project:"demo"},service:true} as never],
    {svc:{availability:"ready",notice:"",members:[w,lead],aiEnabled:true,live:{
      [memberKey(w)]:{key:memberKey(w),match:"exact",state:"idle",detail:"",activity:act("idle")},
      [memberKey(lead)]:{key:memberKey(lead),match:"exact",state:"running",detail:"",activity:act("working")}}}},
    {servers:[server],sessions:[],boards:{svc:{briefs:{},offline:false,tasks:[task("T5","w"),task("T6","w"),task("T7","demo-lead")],parentBy:{}}},themeId:"tokyo-night",animationEnabled:false});
  const [leadSeat,worker]=snapshot.projects[0].sources[0].members;
  expect(leadSeat.isLead).toBe(true);
  expect(leadSeat.doing).toBeUndefined();
  expect(leadSeat.activity?.label).toBe("▶ 干活中");
  expect(worker.doing).toEqual({code:"T5",title:"标题 T5",more:1});
  expect(worker.taskText).toBe("T5 · 标题 T5");
  expect(worker.activity).toMatchObject({label:"⏸ 空闲 · 有卡未动",attention:true});
  expect(worker.status.label).toBe("空闲（团队服务）");
});

it("adventure: Lead shows its activity, never a card badge",()=>{
  const lead=member("demo-lead","Lead");
  const snapshots={demo:{project:"demo",seq:1,lseq:1,members:[lead],ai:{},machines:{},receivedAt:Date.now(),offline:false,status:"online",identity:"demo",
    live:{[memberKey(lead)]:{key:memberKey(lead),match:"exact",state:"idle",detail:"",activity:act("waiting_human","等确认：Bash")}}}};
  const {container}=render(<AdventurePanel service={{url:"https://team.example.invalid/api/v1",projects:["demo"],status:{state:"online",token_configured:true},snapshots} as never}
    servers={[server]} sessions={[]} onOpen={async()=>{}} onClose={()=>{}}/>);
  expect(container.querySelector(".adventure-status")?.textContent).toBe("✋ 等人");
  expect(container.querySelector(".team-card-badge")).toBeNull();
});

it("AI summaries older than 30 minutes are marked 旧, and the AI status word is gone",()=>{
  const now=Date.now();
  const at=(minutes:number)=>new Date(now-minutes*60_000).toISOString();
  expect(aiIsOld({since:at(31)},now)).toBe(true);
  expect(aiIsOld({updatedAt:at(29)},now)).toBe(false);
  expect(aiIsOld({since:at(45),updatedAt:at(1)},now)).toBe(true);
  const {container,rerender}=render(<TeamServiceAi ai={{status:"working",summary:"在跑测试",evidence:"",model:"m",updatedAt:at(1),since:at(45)}}/>);
  expect(container.querySelector(".team-service-ai")?.classList.contains("is-old")).toBe(true);
  expect(container.textContent).toContain("旧");
  expect(container.textContent).not.toContain("工作中");
  rerender(<TeamServiceAi ai={{status:"working",summary:"在跑测试",evidence:"",model:"m",updatedAt:at(5),since:at(5)}}/>);
  expect(container.textContent).not.toContain("旧");
});
