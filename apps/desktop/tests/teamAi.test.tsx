import {act,fireEvent,render,screen,waitFor} from "@testing-library/react";
import {beforeEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import TeamAiSettings from "../src/components/TeamAiSettings";
import TeamDynamics from "../src/components/TeamDynamics";
import {AI_PROVIDERS,excerptDigest,loadTeamAi,protocolEndpoint,redactTerminal,TEAM_AI_CONFIG,TEAM_AI_PROFILES} from "../src/lib/teamAi";
import {emptyProfile} from "../src/lib/collaboration";
import type {TeamMember} from "../src/lib/teamMembers";
import {memberConnection} from "../src/lib/teamMembers";
import type {ServerEntry} from "../src/types";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
beforeEach(()=>{localStorage.clear();vi.mocked(invoke).mockReset().mockResolvedValue(false);});
const member:TeamMember={project:"demo",email:"w@example.test",role:"测试成员",host:"remote",port:22,username:"dev",workdir:"/repo",tmux:{id:"$2",created:123,name:"worker"}};
const server:ServerEntry={id:"server",name:"remote",host:"remote",port:22,username:"dev",authMethod:"password"};
const profile={...emptyProfile(),enabled:true,membersEnabled:true,project:"demo",workdir:"/lead",tmuxId:"$1",tmuxCreated:100,tmuxName:"lead"};

it("uses live panes despite duplicate connection entries and normalized host spelling",()=>{
  const first={...server,id:"one",host:" REMOTE "};const second={...server,id:"two"};
  const live=[{pane:{server:first,tmux:member.tmux},backendId:""},{pane:{server:second,tmux:member.tmux},backendId:"worker-ssh"}];
  expect(memberConnection(member,[first,second],live).backend).toBe("worker-ssh");
  expect(memberConnection(member,[first],live).backend).toBe("worker-ssh");
  expect(memberConnection(member,[first],[{pane:{server:{...second,username:"other"}},backendId:"wrong-user"}]).backend).toBeUndefined();
});

it("finds the live worker on another IP instead of a stale mapped address",()=>{
  const old={...server,host:"192.168.30.108"};
  const current={...server,id:"vpn-route",host:"100.66.1.8",port:2222};
  const worker={...member,host:old.host};
  const pane={server:current,tmux:worker.tmux,tmuxWorkdir:worker.workdir};
  const mappings={[JSON.stringify([worker.project,worker.email,worker.host,worker.port,worker.username])]:old.id};
  expect(memberConnection(worker,[old,current],[{pane,backendId:"vpn-ssh"}],mappings)).toEqual({server:current,backend:"vpn-ssh"});
  expect(memberConnection(worker,[old,current],[{pane:{...pane,tmux:{...pane.tmux,created:999}},backendId:"reused"}],mappings).backend).toBeUndefined();
  expect(memberConnection(worker,[old,current],[{pane:{...pane,tmuxWorkdir:"/another"},backendId:"wrong-root"}],mappings).backend).toBeUndefined();
  expect(memberConnection(worker,[old,current],[{pane,backendId:"vpn-ssh"},{pane:{...pane,server:{...current,id:"unrelated",host:"different-host"}},backendId:"ambiguous"}],mappings).backend).toBeUndefined();
});

it("automatically retries failed capture when the worker SSH connection becomes live",async()=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[1].endpoint,model:"example"}));
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="ssh_live_connections")return [];
    if(command==="team_ai_capture")return "等待派工";
    if(command==="team_ai_summarize")return {status:"idle",summary:"等待派工"};
    if(args?.request?.operation==="memberLease")return JSON.stringify({granted:true});
    return JSON.stringify([member]);
  });
  const leadServer={...server,id:"lead-host",host:"lead-host"};
  const navigation={server:leadServer,servers:[leadServer,server,{...server,id:"duplicate"}],onOpen:vi.fn()};
  const onUpdated=vi.fn().mockResolvedValue(undefined);
  const view=render(<TeamDynamics sessionId="lead-ssh" profile={profile} members={[member]} navigation={navigation} onUpdated={onUpdated}/>);
  fireEvent.click(screen.getByText("开启自动总结"));fireEvent.click(screen.getByText("确认开启"));
  await screen.findByText(/尚无可用 SSH 连接/);
  view.rerender(<TeamDynamics sessionId="lead-ssh" profile={profile} members={[member]} navigation={{...navigation,sessions:[{pane:{id:"worker-pane",server,tmux:member.tmux},backendId:"worker-ssh"}]}} onUpdated={onUpdated}/>);
  await screen.findByText("已更新 1 个摘要。");
  expect(invoke).toHaveBeenCalledWith("team_ai_capture",{sessionId:"worker-ssh",target:{id:"$2",created:123},workdir:"/repo"});
  expect(screen.queryByText(/尚无可用 SSH 连接/)).toBeNull();
});

it("captures through backend inventory when the current window has no registered worker pane",async()=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[1].endpoint,model:"example"}));
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="ssh_live_connections")return [{sessionId:"actual-live-ssh",serverId:server.id,host:server.host,port:22,username:"dev"}];
    if(command==="team_ai_capture")return "等待派工";
    if(command==="team_ai_summarize")return {status:"idle",summary:"等待派工"};
    if(args?.request?.operation==="memberLease")return JSON.stringify({granted:true});
    return JSON.stringify([member]);
  });
  render(<TeamDynamics sessionId="lead-ssh" profile={profile} members={[member]} navigation={{server:{...server,id:"lead",host:"lead"},servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  fireEvent.click(screen.getByRole("button",{name:"总结 · 测试成员"}));
  await screen.findByText("已更新 测试成员");
  expect(invoke).toHaveBeenCalledWith("team_ai_capture",{sessionId:"actual-live-ssh",target:{id:"$2",created:123},workdir:"/repo"});
});

it("explains unmatched live routes without capturing another user's terminal",async()=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[1].endpoint,model:"example"}));
  vi.mocked(invoke).mockResolvedValue([{sessionId:"wrong-user",host:member.host,port:22,username:"someone-else",tmux:member.tmux}]);
  render(<TeamDynamics sessionId="lead-ssh" profile={profile} members={[member]} navigation={{server:{...server,id:"lead",host:"lead"},servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  fireEvent.click(screen.getByRole("button",{name:"总结 · 测试成员"}));
  await screen.findByText(/后端在线连接 1 个/);
  expect(screen.getByRole("alert").textContent).toContain("someone-else@remote:22");
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="team_ai_capture"||c==="team_ai_summarize")).toBe(false);
});

it("labels old AI summaries as expired instead of implying current status",()=>{
  const old={...member,aiSummary:"实现合账模块",aiStatus:"working",aiUpdatedAt:new Date(Date.now()-600000).toISOString(),aiSource:JSON.stringify([member.host,member.port,member.username,member.workdir,member.tmux.id,member.tmux.created])};
  render(<TeamDynamics sessionId="lead-ssh" profile={profile} members={[old]} navigation={{server,servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  expect(screen.getByText("摘要已过期 · 实现合账模块")).toBeTruthy();
  expect(screen.getByText("待确认")).toBeTruthy();
});

it("presets providers and stores keys only through the credential command",async()=>{
  vi.mocked(invoke).mockResolvedValue(true);
  render(<TeamAiSettings/>);
  for(const provider of AI_PROVIDERS){
    fireEvent.change(screen.getByLabelText("供应商"),{target:{value:provider.id}});
    expect((screen.getByLabelText("完整接口地址") as HTMLInputElement).value).toBe(protocolEndpoint(provider.endpoint,"responses"));
  }
  fireEvent.change(screen.getByLabelText("供应商"),{target:{value:"siliconflow"}});
  fireEvent.change(screen.getByLabelText("模型名称"),{target:{value:"example-model"}});
  fireEvent.change(screen.getByLabelText("API Key"),{target:{value:"synthetic-model-secret"}});
  fireEvent.click(screen.getByText("保存模型配置"));
  await screen.findByRole("status");
  expect(invoke).toHaveBeenCalledWith("team_ai_key",{endpointUrl:protocolEndpoint(AI_PROVIDERS[0].endpoint,"responses"),profileId:expect.any(String),key:"synthetic-model-secret"});
  expect(localStorage.getItem(TEAM_AI_CONFIG)).toContain("example-model");
  expect(localStorage.getItem(TEAM_AI_PROFILES)).toContain("硅基流动");
  expect(JSON.stringify(localStorage)).not.toContain("synthetic-model-secret");
});

it("defaults to Responses, preserves legacy chat config and selects fetched models",async()=>{
  expect(loadTeamAi().protocol).toBe("responses");
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[1].endpoint,model:"old-model"}));
  expect(loadTeamAi().protocol).toBe("chat");
  render(<TeamAiSettings/>);
  fireEvent.change(screen.getByLabelText("接口协议"),{target:{value:"responses"}});
  expect((screen.getByLabelText("完整接口地址") as HTMLInputElement).value).toBe("https://api.deepseek.com/responses");
  vi.mocked(invoke).mockImplementation(async command=>command==="team_ai_models"?["model-a","model-b"]:true);
  fireEvent.click(screen.getByText("拉取模型列表"));
  fireEvent.change(await screen.findByLabelText("选择模型"),{target:{value:"model-b"}});
  expect(invoke).toHaveBeenCalledWith("team_ai_models",{endpointUrl:"https://api.deepseek.com/responses",profileId:null,key:null});
  expect((screen.getByLabelText("模型名称") as HTMLInputElement).value).toBe("model-b");
  fireEvent.click(screen.getByText("保存模型配置"));
  await waitFor(()=>expect(loadTeamAi()).toMatchObject({endpoint:"https://api.deepseek.com/responses",model:"model-b",protocol:"responses"}));
});

it("keeps manual model entry available when model retrieval fails",async()=>{
  vi.mocked(invoke).mockRejectedValue(new Error("HTTP 401"));
  render(<TeamAiSettings/>);
  fireEvent.change(screen.getByLabelText("供应商"),{target:{value:"deepseek"}});
  fireEvent.click(screen.getByText("拉取模型列表"));
  await screen.findByText(/HTTP 401/);
  fireEvent.change(screen.getByLabelText("模型名称"),{target:{value:"manual-model"}});
  expect((screen.getByLabelText("模型名称") as HTMLInputElement).value).toBe("manual-model");
});

it("keeps two accounts for one provider separate and shows persisted key status",async()=>{
  const keys=new Map<string,string>();
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command!=="team_ai_key")return [];
    const id=args.profileId??"legacy";
    if(args.key==="")keys.delete(id);else if(args.key)keys.set(id,args.key);
    return keys.has(id);
  });
  const first=render(<TeamAiSettings/>);
  fireEvent.change(screen.getByLabelText("供应商"),{target:{value:"deepseek"}});
  fireEvent.change(screen.getByLabelText("配置名称"),{target:{value:"DeepSeek 主账号"}});
  fireEvent.change(screen.getByLabelText("API Key"),{target:{value:"first-secret"}});
  fireEvent.change(screen.getByLabelText("模型名称"),{target:{value:"example-model"}});
  fireEvent.click(screen.getByText("保存模型配置"));
  await screen.findByText("已保存并启用“DeepSeek 主账号”。");
  await screen.findByText("✓ 已保存");
  const firstId=loadTeamAi().id!;
  fireEvent.click(screen.getByText("新增配置"));
  await screen.findByText("未配置");
  fireEvent.change(screen.getByLabelText("配置名称"),{target:{value:"DeepSeek 备用"}});
  fireEvent.change(screen.getByLabelText("API Key"),{target:{value:"second-secret"}});
  fireEvent.click(screen.getByText("保存模型配置"));
  await screen.findByText("已保存并启用“DeepSeek 备用”。");
  const secondId=loadTeamAi().id!;
  expect(secondId).not.toBe(firstId);
  expect(keys.get(firstId)).toBe("first-secret");expect(keys.get(secondId)).toBe("second-secret");
  expect(Object.keys(JSON.parse(localStorage.getItem(TEAM_AI_PROFILES)!))).toHaveLength(2);
  expect(JSON.stringify(localStorage)).not.toContain("secret");
  first.unmount();render(<TeamAiSettings/>);
  await screen.findByText("✓ 已保存");
  expect((screen.getByLabelText("API Key") as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("模型配置"),{target:{value:firstId}});
  await screen.findByText("✓ 已保存");
  expect(loadTeamAi().id).toBe(firstId);
  fireEvent.click(screen.getByText("删除此配置"));
  await screen.findByText("配置已删除，其他配置保留。");
  expect(keys.has(firstId)).toBe(false);expect(keys.get(secondId)).toBe("second-secret");
  expect(loadTeamAi().id).toBe(secondId);
});

it("ignores a previous account's late credential check",async()=>{
  const endpoint="https://api.deepseek.com/responses";
  const a={id:"account-a",name:"A",endpoint,model:"x"};const b={...a,id:"account-b",name:"B"};
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify(a));
  localStorage.setItem(TEAM_AI_PROFILES,JSON.stringify({a,b}));
  let finish!:(v:boolean)=>void;
  vi.mocked(invoke).mockImplementation(async(_command,args:any)=>args.profileId==="account-a"?new Promise<boolean>(resolve=>finish=resolve):false);
  render(<TeamAiSettings/>);
  fireEvent.change(screen.getByLabelText("模型配置"),{target:{value:"b"}});
  await screen.findByText("未配置");
  await act(async()=>finish(true));
  expect(screen.queryByText("✓ 已保存")).toBeNull();
});

it("redacts common tokens and private keys before preview or sending",()=>{
  const text=redactTerminal("build passed\napi_key=secret123\nBearer abc.def\nsk-1234567890123456\n-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-text\n-----END OPENSSH PRIVATE KEY-----");
  expect(text).toContain("build passed");
  for(const secret of ["secret123","abc.def","sk-1234567890123456","private-text"])expect(text).not.toContain(secret);
});

it.each([true,false])("requires preview and send; honors collector lease granted=%s",async(granted)=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[0].endpoint,model:"example"}));
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="team_ai_capture")return "测试完成，等待派工";
    if(command==="team_ai_summarize")return {status:"idle",summary:"测试完成"};
    if(args?.request?.operation==="memberLease")return JSON.stringify({granted});
    return JSON.stringify([member]);
  });
  render(<TeamDynamics sessionId="ssh" profile={profile} members={[member]} navigation={{server,servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  fireEvent.click(screen.getByText("预览终端片段"));
  const send=await screen.findByText("发送片段并总结");
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="team_ai_summarize")).toBe(false);
  fireEvent.click(send);
  if(granted){
    await waitFor(()=>expect(vi.mocked(invoke).mock.calls.some(([c,a]:any)=>c==="collaboration_request"&&a.request.operation==="memberNotes")).toBe(true));
    const call=vi.mocked(invoke).mock.calls.find(([,a]:any)=>a?.request?.operation==="memberNotes")![1] as any;
    expect(JSON.parse(call.request.body)).toMatchObject({aiStatus:"idle",aiSummary:"测试完成"});
  }else{
    await screen.findByText(/另一台设备正在采集/);
    expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="team_ai_summarize")).toBe(false);
  }
});

it("restoring configuration cancels an in-flight preview without sending",async()=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[0].endpoint,model:"example"}));
  let finish!:(value:string)=>void;
  vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  render(<TeamDynamics sessionId="ssh" profile={profile} members={[member]} navigation={{server,servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  fireEvent.click(screen.getByText("预览终端片段"));
  await waitFor(()=>expect(invoke).toHaveBeenCalledWith("team_ai_capture",expect.anything()));
  await act(async()=>{window.dispatchEvent(new Event("dssh-team-ai-config"));finish("任务完成");});
  await waitFor(()=>expect(screen.queryByText("正在更新…")).toBeNull());
  expect(screen.queryByText("发送片段并总结")).toBeNull();
  expect(vi.mocked(invoke).mock.calls.some(([c])=>c==="team_ai_summarize")).toBe(false);
});

it("starts automatic summaries with one scope confirmation and resumes without preview",async()=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[1].endpoint,model:"example"}));
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="team_ai_capture")return "等待派工";
    if(command==="team_ai_summarize")return {status:"idle",summary:"等待派工"};
    if(args?.request?.operation==="memberLease")return JSON.stringify({granted:true});
    return JSON.stringify([member]);
  });
  render(<TeamDynamics sessionId="ssh" profile={profile} members={[member]} navigation={{server,servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  expect((screen.getByLabelText("测试成员") as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/设置与详情/).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("开启自动总结"));
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("确认开启"));
  await screen.findByText("已更新 1 人");
  expect(screen.queryByText("确认开启")).toBeNull();
  expect(screen.queryByText("发送片段并总结")).toBeNull();
  fireEvent.click(screen.getByText("暂停"));
  fireEvent.click(screen.getByText("开启自动总结"));
  await screen.findByText("已更新 1 人");
  expect(screen.queryByText("确认开启")).toBeNull();
  act(()=>window.dispatchEvent(new Event("dssh-team-ai-config")));
  fireEvent.click(screen.getByText("开启自动总结"));
  expect(screen.getByText("确认开启")).toBeTruthy();
});

it("summarizes only the clicked worker even when unselected and output is unchanged",async()=>{
  localStorage.setItem(TEAM_AI_CONFIG,JSON.stringify({endpoint:AI_PROVIDERS[1].endpoint,model:"example"}));
  const source=JSON.stringify([member.host,member.port,member.username,member.workdir,member.tmux.id,member.tmux.created]);
  const worker={...member,aiSource:source,aiDigest:await excerptDigest(JSON.stringify([loadTeamAi(),source,"等待派工"]))};
  const other={...member,email:"other@example.test",role:"其他成员",tmux:{...member.tmux,id:"$3"}};
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="team_ai_capture")return "等待派工";
    if(command==="team_ai_summarize")return {status:"idle",summary:"等待派工"};
    if(args?.request?.operation==="memberLease")return JSON.stringify({granted:true});
    return JSON.stringify([worker,other]);
  });
  render(<TeamDynamics sessionId="ssh" profile={profile} members={[worker,other]} navigation={{server,servers:[server],onOpen:vi.fn()}} onUpdated={vi.fn().mockResolvedValue(undefined)}/>);
  fireEvent.click(screen.getByLabelText("测试成员"));
  const button=screen.getByRole("button",{name:"总结 · 测试成员"});
  fireEvent.click(button);
  await screen.findByText("已更新 测试成员");
  expect(button.closest("details")?.open).toBe(false);
  expect((screen.getByLabelText("测试成员") as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("开启自动总结")).toBeTruthy();
  const captures=vi.mocked(invoke).mock.calls.filter(([c])=>c==="team_ai_capture");
  expect(captures).toHaveLength(1);
  expect(captures[0][1]).toMatchObject({target:{id:"$2",created:123}});
  expect(vi.mocked(invoke).mock.calls.filter(([c])=>c==="team_ai_summarize")).toHaveLength(1);
  const writes=vi.mocked(invoke).mock.calls.filter(([,a]:any)=>a?.request?.operation==="memberNotes");
  expect(writes).toHaveLength(1);
  expect(JSON.parse((writes[0][1] as any).request.body).email).toBe(member.email);
});
