import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TeamMembers from "../src/components/TeamMembers";
import CollaborationPanel from "../src/components/CollaborationPanel";
import TeamDynamics from "../src/components/TeamDynamics";
import TeamPanel from "../src/components/TeamPanel";
import ToolRail from "../src/components/ToolRail";
import { teamLeadPrompt } from "../src/lib/teamLeadPrompt";
import { collaborationKey, emptyProfile, loadCollaboration, saveCollaboration } from "../src/lib/collaboration";
import { connectedMemberTab, matchingServers, parseMember, type TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";
import type { AgentSession, LiveSessions } from "../src/lib/agentSessions";
import type { BoardSource } from "../src/lib/taskLookup";

vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn()}));
const member:TeamMember = {project:"demo", email:"worker@example.test", role:"cw2", host:"remote", port:22, username:"dev", workdir:"/repo", tmux:{id:"$2", created:123, name:"worker"}};
const server:ServerEntry = {id:"local-device-id", name:"开发机", host:"remote", port:22, username:"dev", authMethod:"password"};
const profile = {...emptyProfile(), enabled:true, taskboardEnabled:true, project:"demo", workdir:"/lead", tmuxId:"$1", tmuxCreated:100, tmuxName:"lead", taskboardUrl:"https://board.test"};

/** Open a closed <details> the way the panel's own onToggle state expects. */
async function expand(el: HTMLElement | null) {
  const details = el?.closest("details");
  if (!details) throw new Error("details not found");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await waitFor(() => expect((el!.closest("details") as HTMLDetailsElement).open).toBe(true));
  await new Promise(resolve => setTimeout(resolve, 20));   // 让 React 提交这次展开
  return details;
}

beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset().mockResolvedValue(JSON.stringify([member])); });

it("renders one merged team view without tabs and keeps member actions reachable",async()=>{
  const onOpen=vi.fn().mockResolvedValue(undefined);
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen}}/>);
  const dynamics=screen.getByRole("region",{name:"团队动态"});
  expect(dynamics).toBeTruthy();
  // 页签已合并：不再有「动态 / 成员」切换按钮
  expect(screen.queryByRole("button",{name:/^成员 \d+$/})).toBeNull();
  expect(screen.queryByRole("button",{name:"动态"})).toBeNull();
  fireEvent.click(await screen.findByRole("button",{name:"打开 · cw2 · worker"}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledWith(member,server));
  // 原成员页的管理操作都在每人的展开详情里（先展开所在分组与该成员）
  await expand(await screen.findByText("待确认（Lead 手写）"));
  await expand(screen.getByRole("button",{name:"打开 · cw2 · worker"}));
  expect(screen.getByRole("button",{name:"编辑备注 · cw2"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"更新终端"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"从团队移除"})).toBeTruthy();
  expect(screen.getByRole("button",{name:"打开终端 · cw2"})).toBeTruthy();
  // 复制提示词收进「更多」
  await expand(await screen.findByText("更多"));
  expect(screen.getByRole("button",{name:"复制给 Lead 的提示词"})).toBeTruthy();
  expect(document.querySelector(".team-members .team-member-avatar")).toBeNull();
  expect(screen.getByRole("region",{name:"团队动态"})).toBe(dynamics);
});

it.each(["saved", "new"])("exits a %s team locally and lets the mistaken window bind a different project", async source=>{
  const pane={id:"lead",server,tmux:{id:"$1",created:100,name:"worker"}};
  const other={...profile,tmuxId:"$7"};
  saveCollaboration(server.id,other);
  if(source==="saved")saveCollaboration(server.id,profile);
  vi.mocked(invoke).mockImplementation(async command=>command==="collaboration_worktree"?"/lead":"[]");
  render(<TeamPanel sessionId="ssh" pane={pane} profile={source==="saved"?profile:undefined} navigation={{server,servers:[server],onOpen:vi.fn()}} onClose={vi.fn()}/>);
  if(source==="new"){
    fireEvent.click(await screen.findByText("将当前窗口设为 Lead"));
    fireEvent.change(screen.getByLabelText("项目名称"),{target:{value:"demo"}});
    fireEvent.click(screen.getByRole("button",{name:"打开此项目的团队"}));
  }
  await screen.findByRole("button",{name:"退出团队"});
  const count=vi.mocked(invoke).mock.calls.length;
  fireEvent.click(screen.getByRole("button",{name:"退出团队"}));
  fireEvent.click(await screen.findByText("将当前窗口设为 Lead"));
  expect(screen.getByText(/已退出团队/)).toBeTruthy();
  expect(screen.queryByRole("button",{name:"退出团队"})).toBeNull();
  expect(vi.mocked(invoke).mock.calls.slice(count).every(([command,args]:any)=>command==="collaboration_worktree" || args.request?.operation==="members")).toBe(true);
  expect(loadCollaboration()[collaborationKey(server.id,profile)]).toBeUndefined();
  expect(loadCollaboration()[collaborationKey(server.id,other)]).toEqual(other);
  fireEvent.change(screen.getByLabelText("项目名称"),{target:{value:"correct-project"}});
  fireEvent.click(screen.getByRole("button",{name:"打开此项目的团队"}));
  await screen.findByText("团队 · correct-project");
  expect(loadCollaboration()[collaborationKey(server.id,profile)].project).toBe("correct-project");
});

it("portable positions strip secrets and local IDs, reject foreign projects and reused identities", () => {
  expect(parseMember({...member, password:"secret", serverId:"old-device"}, "demo")).toEqual(member);
  for (const invalid of [{...member, project:"other"}, {...member, tmux:{...member.tmux, created:0}}, {...member, port:70000}, {...member, workdir:"relative"}]) {
    expect(() => parseMember(invalid, "demo")).toThrow();
  }
  expect(matchingServers(member, [server, {...server, id:"root", username:"root"}, {...server, id:"other-port", port:2222}])).toEqual([server]);
});

it("copies a project-specific executable Lead guide without credentials or remote writes",async()=>{
  const writeText=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
  const p={...profile,workdir:"/lead's repo",tokenFile:"/private/token"};
  render(<TeamMembers sessionId="ssh" profile={p} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  await expand(await screen.findByText("待确认（Lead 手写）"));
  await screen.findByRole("button",{name:"打开 · cw2 · worker"});
  const count=vi.mocked(invoke).mock.calls.length;
  await expand(await screen.findByText("更多"));
  fireEvent.click(screen.getByRole("button",{name:"复制给 Lead 的提示词"}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledWith(teamLeadPrompt(p,server)));
  const prompt=writeText.mock.calls[0][0] as string;
  expect(prompt).toContain("cd '/lead'\"'\"'s repo'");
  expect(prompt).toContain("memberBatch @.dssh/team/pending-members.json");
  expect(prompt).toContain("fcntl.flock");
  expect(prompt).not.toContain("/private/token");
  expect(invoke).toHaveBeenCalledTimes(count);
});

it("shows Lead notes and edits them without sending a stale terminal location",async()=>{
  const annotated={...member,responsibilities:"后端",quota:"未知",currentTask:"T12 测试中",notes:"等待审查"};
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([annotated]));
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  await expand(await screen.findByText("工作中（Lead 手写）"));
  await expand(await screen.findByRole("button",{name:"打开 · cw2 · worker"}));
  await screen.findByLabelText("成员摘要");
  expect(screen.getByLabelText("成员摘要").textContent).toContain("T12 测试中");
  expect(screen.getByText("详细信息").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"编辑备注 · cw2"}));
  expect(screen.queryByLabelText("额度情况")).toBeNull();
  fireEvent.change(screen.getByLabelText("其他备注"),{target:{value:"等待验收"}});
  fireEvent.click(screen.getByRole("button",{name:"保存备注"}));
  await screen.findByText("成员备注已保存。");
  const save=vi.mocked(invoke).mock.calls.find(([,args]:any)=>args.request?.operation==="memberNotes")!;
  const payload=JSON.parse((save[1] as any).request.body);
  expect(payload).toMatchObject({project:"demo",email:member.email,notes:"等待验收",responsibilities:"后端",currentTask:"T12 测试中"});
  expect(payload).not.toHaveProperty("tmux");
  expect(payload).not.toHaveProperty("host");
  expect(payload).not.toHaveProperty("quota");
  expect(parseMember(annotated,"demo").notes).toBe("等待审查");
  expect(()=>parseMember({...member,notes:["invalid"]},"demo")).toThrow();
});

it("reuses a live split pane across saved IDs only after verifying its remote worktree", async () => {
  const tabs = [{id:"old", activePane:0, panes:[{id:"offline", server, tmux:member.tmux}]},
    {id:"live", activePane:0, panes:[{id:"shell", server}, {id:"worker", server:{...server,id:"other-local-id"}, tmux:member.tmux}]}];
  vi.mocked(invoke).mockResolvedValue("/repo");
  expect(await connectedMemberTab(member, server, tabs, {worker:"ssh-worker"}, "old")).toMatchObject({tab:{id:"live"}, paneIndex:1});
  expect(invoke).toHaveBeenCalledWith("collaboration_worktree", {sessionId:"ssh-worker", target:{id:"$2", created:123}});
  vi.mocked(invoke).mockResolvedValue("/different-repo");
  await expect(connectedMemberTab(member, server, tabs, {worker:"ssh-worker"})).rejects.toThrow("工作区已变化");
  vi.mocked(invoke).mockClear();
  expect(await connectedMemberTab({...member, tmux:{...member.tmux, created:999}}, server, tabs, {worker:"ssh-worker"})).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

it("reads the shared remote roster and opens the member with this device's connection", async () => {
  const onOpen = vi.fn().mockResolvedValue(undefined);
  render(<TeamMembers sessionId="lead-ssh" profile={profile} navigation={{server, servers:[server], onOpen}}/>);
  await expand(await screen.findByText("待确认（Lead 手写）"));
  fireEvent.click(await screen.findByRole("button", {name:"打开 · cw2 · worker"}));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(member, server));
  expect(invoke).toHaveBeenCalledWith("collaboration_request", {sessionId:"lead-ssh", profile, request:{operation:"members", body:""}});
});

it("requires an explicit alias mapping when no endpoint matches and remembers it locally", async () => {
  const alias = {...server, host:"192.0.2.5"};
  // 本窗口的服务器也不是这位成员（否则实时连接会自动解析出可用终端）
  const leadOnly = {...server, id:"lead-device", host:"lead-remote"};
  const onOpen = vi.fn().mockResolvedValue(undefined);
  const props = {sessionId:"lead-ssh", profile, navigation:{server:leadOnly, servers:[alias], onOpen}};
  const view = render(<TeamMembers {...props}/>);
  await expand(await screen.findByText("待确认（Lead 手写）"));
  const button = await screen.findByRole("button", {name:"打开 · cw2 · worker"});
  await expand(button);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("本机连接 · cw2"), {target:{value:alias.id}});
  fireEvent.click(button);
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(member, alias));
  view.unmount();
  render(<TeamMembers {...props}/>);
  await expand(await screen.findByText("待确认（Lead 手写）"));
  await expand(await screen.findByRole("button", {name:"打开 · cw2 · worker"}));
  expect((await screen.findByLabelText("本机连接 · cw2") as HTMLSelectElement).value).toBe(alias.id);
});

it("reports stale sessions and never silently retargets a member", async () => {
  const onOpen = vi.fn().mockRejectedValue(new Error("成员会话已结束"));
  render(<TeamMembers sessionId="lead-ssh" profile={profile} navigation={{server, servers:[server], onOpen}}/>);
  await expand(await screen.findByText("待确认（Lead 手写）"));
  fireEvent.click(await screen.findByRole("button", {name:"打开 · cw2 · worker"}));
  // 合并后打开终端走面板内的状态提示（原成员页用的是 alert，行为等价）
  expect((await screen.findByRole("status")).textContent).toContain("成员会话已结束");
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("registers only validated location fields and does not send agent messages", async () => {
  render(<TeamMembers sessionId="lead-ssh" profile={profile} navigation={{server, servers:[server], onOpen:vi.fn()}}/>);
  await screen.findByRole("button",{name:"打开 · cw2 · worker"});
  await expand(await screen.findByText("更多"));
  fireEvent.change(screen.getByLabelText("成员位置 JSON"), {target:{value:JSON.stringify({...member, password:"secret"})}});
  fireEvent.click(screen.getByRole("button", {name:"登记到当前团队"}));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("collaboration_request", {sessionId:"lead-ssh", profile, request:{operation:"memberSave", body:JSON.stringify(member)}}));
  expect(JSON.stringify(vi.mocked(invoke).mock.calls)).not.toContain("secret");
});

it("adds an open terminal without email or JSON using its actual remote worktree", async()=>{
  vi.mocked(invoke).mockImplementation(async (command,args:any)=>command==="collaboration_worktree"?"/worker/repo":args.request.operation==="memberSave"?JSON.stringify([JSON.parse(args.request.body)]):"[]");
  const pane={id:"worker-pane",server,tmux:{id:"$9",created:987,name:"后端开发"}};
  render(<TeamMembers sessionId="lead-ssh" profile={profile} navigation={{server,servers:[server],sessions:[{pane,backendId:"worker-ssh"}],onOpen:vi.fn()}}/>);
  await screen.findByText("把成员终端放在一起");
  fireEvent.click(screen.getByRole("button",{name:"添加成员"}));
  fireEvent.change(screen.getByLabelText("成员终端"),{target:{value:"worker-pane"}});
  expect((screen.getByLabelText("成员名称") as HTMLInputElement).value).toBe("后端开发");
  fireEvent.click(screen.getByRole("button",{name:"加入团队"}));
  await expand(await screen.findByText("待确认（Lead 手写）"));
  await expand(await screen.findByRole("button",{name:"打开 · 后端开发 · 后端开发"}));
  await screen.findByRole("button",{name:"打开终端 · 后端开发"});
  const save=vi.mocked(invoke).mock.calls.find(([,args]:any)=>args.request?.operation==="memberSave")!;
  expect(JSON.parse((save[1] as any).request.body)).toMatchObject({email:"",id:expect.stringMatching(/^member-/),workdir:"/worker/repo",host:"remote",tmux:{id:"$9",created:987}});
  expect(invoke).toHaveBeenCalledWith("collaboration_worktree",{sessionId:"worker-ssh",target:{id:"$9",created:987}});
});

it("exposes a team entry without mail or taskboard and creates a members-only profile",async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==="collaboration_worktree"?"/lead/repo":"[]");
  const pane={id:"lead",server,tmux:{id:"$1",created:100,name:"lead"}};
  render(<><ToolRail side="right" active={null} teamEnabled onSelect={vi.fn()}/><TeamPanel sessionId="ssh" pane={pane} navigation={{server,servers:[server],onOpen:vi.fn()}} onClose={vi.fn()}/></>);
  expect(screen.getByRole("button",{name:"团队 · 打开成员终端"})).toBeTruthy();
  expect(screen.queryByRole("button",{name:"Agent 协作"})).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByText("将当前窗口设为 Lead"));
  fireEvent.change(screen.getByLabelText("项目名称"),{target:{value:"demo"}});
  fireEvent.click(screen.getByRole("button",{name:"打开此项目的团队"}));
  await screen.findByRole("button",{name:"添加成员"});
  const saved=Object.values(JSON.parse(localStorage.getItem("dssh.collaboration.v2")!))[0];
  expect(saved).toMatchObject({enabled:true,membersEnabled:true,mailEnabled:false,taskboardEnabled:false,workdir:"/lead/repo"});
});

it("recognizes a member across servers and opens the original Lead instead of offering setup",async()=>{
  const leadServer={...server,id:"lead-server",host:"lead-remote"};
  saveCollaboration(leadServer.id,profile);
  const onOpen=vi.fn().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async command=>command==="collaboration_worktree"?"/repo":JSON.stringify([{...member,responsibilities:"后端实现"}]));
  render(<TeamPanel sessionId="worker-ssh" pane={{id:"worker",server,tmux:member.tmux}} navigation={{server,servers:[server,leadServer],sessions:[{pane:{id:"lead",server:leadServer,tmux:{id:"$1",created:100,name:"lead"}},backendId:"lead-ssh"}],onOpen}} onClose={vi.fn()}/>);
  await screen.findByText("当前窗口是团队成员");
  expect(screen.getByText("demo · cw2")).toBeTruthy();
  expect(screen.getByLabelText("成员摘要").textContent).toContain("后端实现");
  expect(screen.queryByLabelText("项目名称")).toBeNull();
  expect(screen.getByRole("button",{name:"将当前窗口设为 Lead"})).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("collaboration_request",{sessionId:"lead-ssh",profile,request:{operation:"members"}});
  fireEvent.click(screen.getByRole("button",{name:"打开 Lead 终端"}));
  await waitFor(()=>expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({project:"demo",host:"lead-remote",workdir:"/lead",tmux:{id:"$1",created:100,name:"lead"}}),leadServer));
});

it.each(["reused-session","different-worktree"])("does not identify a stale member: %s",async reason=>{
  saveCollaboration(server.id,profile);
  vi.mocked(invoke).mockImplementation(async command=>command==="collaboration_worktree"?(reason==="different-worktree"?"/other":"/repo"):JSON.stringify([member]));
  render(<TeamPanel sessionId="ssh" pane={{id:"worker",server,tmux:{...member.tmux,created:reason==="reused-session"?999:member.tmux.created}}} navigation={{server,servers:[server],onOpen:vi.fn()}} onClose={vi.fn()}/>);
  await screen.findByText("将当前窗口设为 Lead");
  expect(screen.queryByRole("button",{name:"打开 Lead 终端"})).toBeNull();
  expect(screen.getByText("将当前窗口设为 Lead").closest("details")?.open).toBe(false);
});

it("keeps failed membership discovery distinct from a new team",async()=>{
  saveCollaboration(server.id,profile);
  vi.mocked(invoke).mockRejectedValue(new Error("SSH disconnected"));
  render(<TeamPanel sessionId="ssh" pane={{id:"worker",server,tmux:member.tmux}} navigation={{server,servers:[server],onOpen:vi.fn()}} onClose={vi.fn()}/>);
  await screen.findByText("部分团队尚未确认，请连接 Lead 所在服务器后刷新。");
  expect(screen.getByRole("alert").textContent).toContain("SSH disconnected");
  expect(screen.getByText("将当前窗口设为 Lead").closest("details")?.open).toBe(false);
});

it.each(["same","different-root","recreated","missing-roster"])("recovers an alternate-IP Lead only from its verified remote roster: %s",async mode=>{
  const original={...server,id:"old-route",host:"192.0.2.7"};
  const alternate={...server,id:"new-route",host:"192.168.1.7",port:2222};
  saveCollaboration(original.id,profile);
  const target={id:profile.tmuxId,created:mode==="recreated"?999:profile.tmuxCreated,name:"lead"};
  const lead={...member,role:"Lead",host:original.host,workdir:profile.workdir,tmux:{id:profile.tmuxId,created:profile.tmuxCreated,name:"lead"}};
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==="collaboration_worktree")return mode==="different-root"?"/another":profile.workdir;
    return JSON.stringify(mode==="missing-roster"?[]:[lead]);
  });
  render(<TeamPanel sessionId="alternate-ssh" pane={{id:"lead-alt",server:alternate,tmux:target}} navigation={{server:alternate,servers:[original,alternate],onOpen:vi.fn()}} onClose={vi.fn()}/>);
  const restoredKey=collaborationKey(alternate.id,profile);
  if(mode==="same"){
    await screen.findByRole("button",{name:"退出团队"});
    expect(loadCollaboration()[restoredKey]).toMatchObject({project:"demo",workdir:profile.workdir,membersEnabled:true,taskboardEnabled:false,mailEnabled:false});
    expect(loadCollaboration()[collaborationKey(original.id,profile)]).toEqual(profile);
    expect(Object.values(JSON.parse(localStorage.getItem("dssh.team-connections.v1")!))).toContain(alternate.id);
    expect(vi.mocked(invoke).mock.calls.some(([c,a]:any)=>c==="collaboration_request"&&a.sessionId==="alternate-ssh"&&a.request.operation==="members")).toBe(true);
  }else{
    await screen.findByText("尚未识别到所属团队。如果这是成员窗口，请先打开已有 Lead 的团队，再回来刷新。");
    expect(loadCollaboration()[restoredKey]).toBeUndefined();
    expect(screen.queryByRole("button",{name:"退出团队"})).toBeNull();
  }
  expect(vi.mocked(invoke).mock.calls.every(([c,a]:any)=>c==="collaboration_worktree"||a.request?.operation==="members")).toBe(true);
});

it("without a board, groups by the Lead's hand-written note (working, idle, unknown) and labels it as such",async()=>{
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([
    {...member,role:"空闲成员",currentTask:"空闲116h，无在飞卡"},
    {...member,email:"busy@example.test",role:"工作成员",currentTask:"T762等待验收"},
    {...member,email:"unknown@example.test",role:"未知成员",currentTask:"待确认\n历史：空闲"},
  ]));
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  const working=await screen.findByRole("region",{name:"工作中（Lead 手写）成员"});
  expect(working.textContent).toContain("工作成员");
  expect(screen.getByRole("region",{name:"空闲（Lead 手写）成员"}).textContent).toContain("空闲成员");
  expect(screen.getByRole("region",{name:"待确认（Lead 手写）成员"}).textContent).toContain("未知成员");
  expect(screen.getAllByRole("region").map(el=>el.getAttribute("aria-label"))).toEqual(["团队成员","团队动态","工作中（Lead 手写）成员","空闲（Lead 手写）成员","待确认（Lead 手写）成员"]);
  expect(screen.getAllByText(/未配置看板，无法显示实时状态/)).toHaveLength(1);
});

it.each([true,false])("promotes a member only after checking the migrated roster (present=%s)",async migrated=>{
  const leadServer={...server,id:"old-lead",host:"old-lead.test"};
  saveCollaboration(leadServer.id,profile);
  vi.mocked(invoke).mockImplementation(async(command,args:any)=>{
    if(command==="collaboration_worktree")return "/repo";
    if(command==="collaboration_request")return JSON.stringify(args.sessionId==="old-ssh"||migrated?[member]:[]);
    return [];
  });
  render(<TeamPanel sessionId="new-ssh" pane={{id:"worker",server,tmux:member.tmux}} navigation={{server,servers:[server,leadServer],sessions:[{pane:{id:"old",server:leadServer},backendId:"old-ssh"}],onOpen:vi.fn()}} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button",{name:"将当前窗口设为 Lead"}));
  const newKey=collaborationKey(server.id,{tmuxId:member.tmux.id,tmuxCreated:member.tmux.created,workdir:member.workdir});
  expect(loadCollaboration()[newKey]).toBeUndefined();
  if(migrated){
    fireEvent.click(await screen.findByRole("button",{name:"确认设为 Lead"}));
    await screen.findByRole("button",{name:"添加成员"});
    expect(loadCollaboration()[newKey]).toMatchObject({project:"demo",workdir:"/repo",membersEnabled:true,tmuxId:"$2"});
  }else{
    expect((await screen.findByRole("alert")).textContent).toContain("没有团队名单");
    expect(screen.queryByRole("button",{name:"确认设为 Lead"})).toBeNull();
    expect(loadCollaboration()[newKey]).toBeUndefined();
  }
  expect(loadCollaboration()[collaborationKey(leadServer.id,profile)]).toEqual(profile);
  expect(vi.mocked(invoke).mock.calls.every(([command,args]:any)=>command==="collaboration_worktree"||args.request?.operation==="members")).toBe(true);
});

it("opens the room from the merged toolbar without inline roster avatars and pauses it when hidden",async()=>{
  const officeSnapshot={version:1 as const,themeId:"one-light",animationEnabled:true,mailAvailability:"unavailable" as const,projects:[{id:"demo",name:"demo",sources:[{id:"source",label:"Demo",availability:"ready" as const,notice:"",members:[{id:"worker",name:"Worker",isLead:false,status:{state:"working" as const,source:"activity" as const,label:"工作中（成员活动）"},taskText:"Task",taskSource:"manual" as const,paletteKey:"worker"}]}]}]};
  const props={sessionId:"ssh",pane:{id:"lead",server,tmux:{id:"$1",created:100,name:"lead"}},profile,navigation:{server,servers:[server],onOpen:vi.fn()},onClose:vi.fn(),officeSnapshot,onRoomOpenChange:vi.fn(),onPopOut:vi.fn().mockResolvedValue(undefined)};
  const view=render(<TeamPanel {...props}/>);
  // 列表与房间同一个工具栏入口，标题栏不再有第二个「房间」按钮
  await screen.findByRole("region", {name:"Lead成员"}).catch(()=>undefined);
  const buttons=screen.getAllByRole("button",{name:"房间",exact:true});
  expect(buttons).toHaveLength(1);
  expect(view.container.querySelector(".team-office")).toBeNull();
  expect(props.onRoomOpenChange).toHaveBeenLastCalledWith(false);
  // 打开房间：列表让位给房间，采集门控打开、动画开始
  fireEvent.click(buttons[0]);
  const avatar=view.container.querySelector('.team-office .team-member-avatar')!;
  expect(avatar.getAttribute("data-paused")).toBe("false");
  expect(props.onRoomOpenChange).toHaveBeenLastCalledWith(true);
  expect(view.container.querySelector(".team-members button[aria-pressed=true]")).toBeTruthy();
  // 弹出窗口仍可用
  fireEvent.click(screen.getByRole("button",{name:"弹出窗口"}));
  await waitFor(()=>expect(props.onPopOut).toHaveBeenCalledTimes(1));
  // 主窗口不可见时暂停
  view.rerender(<TeamPanel {...props} officeVisible={false}/>);
  expect(avatar.getAttribute("data-paused")).toBe("true");
  view.rerender(<TeamPanel {...props} officeVisible/>);
  expect(avatar.getAttribute("data-paused")).toBe("false");
  // 再点回列表：房间卸载、门控复位
  fireEvent.click(screen.getByRole("button",{name:"房间",exact:true}));
  expect(view.container.querySelector(".team-office")).toBeNull();
  expect(props.onRoomOpenChange).toHaveBeenLastCalledWith(false);
  expect(view.container.querySelector('.team-members .team-member-avatar')).toBeNull();
  view.unmount();
  expect(props.onRoomOpenChange).toHaveBeenLastCalledWith(false);
});

// ── DS-13：合并后的单列表（概览筛选 / 空闲紧凑行 / 名字去重 / 无当前卡） ──────────

const board: BoardSource = {route:{kind:"direct",url:"https://board.test"},key:"demo-board",webUrl:"https://board.test",label:"看板"};
const NOW = 1_760_000_000;
const asSession = (over: Partial<AgentSession> & {session:string}): AgentSession => ({
  host:"remote", box:"", tool:"codex", project:"demo", state:"idle", stateDetail:"",
  stateSince:NOW-120, hostOk:true, hostError:"", stale:false, seenAt:NOW,
  taskCode:"", taskStatus:"", worktree:"/repo", branch:"main",
  commitHash:"abc1234", commitTime:NOW-3600, commitSubject:"fix(x)", dirty:0,
  model:"gpt-6", lastLine:"", ...over,
});
const liveOf = (sessions: AgentSession[]): LiveSessions => ({
  snapshot:{sessions, now:NOW, ttlSeconds:180, alertAfterSeconds:600, collectedAt:NOW},
  briefs:{}, statusNames:{}, offline:false, error:"",
});
const worker = (over: Partial<TeamMember>): TeamMember => ({...member, ...over});

function renderMerged(members: TeamMember[], live: LiveSessions) {
  return render(<TeamDynamics sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}} members={members} onUpdated={async()=>{}} board={board} live={live}/>);
}

it("filters the merged list by the overview counts and clears on a second click", async () => {
  const stuck = worker({email:"stuck@example.test", role:"a", tmux:{...member.tmux, name:"worker-demo-a"}});
  const running = worker({email:"run@example.test", role:"b", tmux:{...member.tmux, name:"worker-demo-b"}});
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  renderMerged([stuck, running, idle], liveOf([
    asSession({session:"worker-demo-a", state:"stuck"}),
    asSession({session:"worker-demo-b", state:"running"}),
    asSession({session:"worker-demo-c", state:"idle"}),
  ]));
  expect(screen.getByRole("region", {name:"需要处理成员"})).toBeTruthy();
  expect(screen.getByRole("region", {name:"运行中成员"})).toBeTruthy();
  expect(screen.getByRole("region", {name:"空闲·可派活成员"})).toBeTruthy();

  const attention = screen.getByRole("button", {name:/需要处理/});
  expect(attention.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(attention);
  expect(attention.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", {name:"需要处理成员"})).toBeTruthy();
  expect(screen.queryByRole("region", {name:"运行中成员"})).toBeNull();
  expect(screen.queryByRole("region", {name:"空闲·可派活成员"})).toBeNull();

  fireEvent.click(attention);   // 再点取消
  expect(attention.getAttribute("aria-pressed")).toBe("false");
  expect(screen.getByRole("region", {name:"运行中成员"})).toBeTruthy();
});

it("shows 没有符合的成员 when the filtered group is empty", async () => {
  const running = worker({email:"run@example.test", role:"b", tmux:{...member.tmux, name:"worker-demo-b"}});
  renderMerged([running], liveOf([asSession({session:"worker-demo-b", state:"running"})]));
  fireEvent.click(screen.getByRole("button", {name:/等 Lead/}));
  expect(screen.getByRole("region", {name:"等 Lead成员"})).toBeTruthy();
  expect(screen.getByRole("status").textContent).toContain("没有符合的成员");
});

it("keeps idle members on one compact row while urgent groups stay cards", async () => {
  const stuck = worker({email:"stuck@example.test", role:"a", tmux:{...member.tmux, name:"worker-demo-a"}});
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  const {container} = renderMerged([stuck, idle], liveOf([
    asSession({session:"worker-demo-a", state:"stuck", taskCode:"DS-1", taskStatus:"doing"}),
    asSession({session:"worker-demo-c", state:"idle", taskCode:"DC-16", taskStatus:"done"}),
  ]));
  expect(container.querySelectorAll(".team-live-card")).toHaveLength(1);
  expect(container.querySelectorAll(".team-compact-row")).toHaveLength(1);
  // 空闲行显示上一张卡号，并从「空闲·可派活」组默认折叠开始
  const idleGroup = screen.getByRole("region", {name:"空闲·可派活成员"});
  expect(idleGroup.querySelector("details")?.open).toBe(false);
  expect(idleGroup.textContent).toContain("DC-16");
});

it("disambiguates repeated roles with the tmux short name", async () => {
  const a = worker({email:"a@example.test", role:"worker", tmux:{id:"$2", created:1, name:"worker-demo-cw1-codex"}});
  const b = worker({email:"b@example.test", role:"worker", tmux:{id:"$3", created:2, name:"worker-demo-cw2-codex"}});
  const solo = worker({email:"solo@example.test", role:"reviewer", tmux:{id:"$4", created:3, name:"worker-demo-reviewer"}});
  renderMerged([a, b, solo], liveOf([
    asSession({session:"worker-demo-cw1-codex", state:"idle"}),
    asSession({session:"worker-demo-cw2-codex", state:"idle"}),
    asSession({session:"worker-demo-reviewer", state:"idle"}),
  ]));
  expect(screen.getByTitle("worker · worker-demo-cw1-codex").textContent).toBe("worker · cw1-codex");
  expect(screen.getByTitle("worker · worker-demo-cw2-codex").textContent).toBe("worker · cw2-codex");
  // 角色在本团队里唯一时只显示角色名
  expect(screen.getByTitle("reviewer · worker-demo-reviewer").textContent).toBe("reviewer");
});

it("does not render a 无当前卡 line for idle members without a card", async () => {
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  const {container} = renderMerged([idle], liveOf([asSession({session:"worker-demo-c", state:"idle"})]));
  expect(screen.queryByText("无当前卡")).toBeNull();
  expect(container.querySelectorAll(".team-card-line2")).toHaveLength(0);
});

it("drops the filter when the live summary disappears instead of trapping an empty list", async () => {
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}, currentTask:"空闲116h"});
  const busy = worker({email:"busy@example.test", role:"w", tmux:{...member.tmux, name:"worker-demo-w"}, currentTask:"T1 进行中"});
  const live = liveOf([
    asSession({session:"worker-demo-c", state:"idle"}),
    asSession({session:"worker-demo-w", state:"running"}),
  ]);
  const ui = (value: LiveSessions) => <TeamDynamics sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}} members={[idle, busy]} onUpdated={async()=>{}} board={board} live={value}/>;
  const view = render(ui(live));
  // 计数块的可读名带数字与空格
  fireEvent.click(screen.getByRole("button", {name:"1 可派活"}));
  expect(screen.getByRole("button", {name:"1 可派活"}).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("region", {name:"空闲·可派活成员"})).toBeTruthy();
  // 看板掉线：没有计数块了，筛选必须一起消失，不能把列表锁在空结果上
  view.rerender(ui({...live, snapshot:undefined, offline:true}));
  await waitFor(() => expect(screen.queryByRole("button", {name:"1 可派活"})).toBeNull());
  expect(screen.queryByText("没有符合的成员")).toBeNull();
  expect(screen.getByRole("region", {name:"工作中（Lead 手写）成员"})).toBeTruthy();
  expect(screen.getByRole("region", {name:"空闲（Lead 手写）成员"})).toBeTruthy();
});

it("keeps the Lead as a compact row whose details still manage the roster", async () => {
  const lead = {...member, email:"lead@example.test", role:"Lead", tmux:{id:"$1", created:100, name:"lead"}, currentTask:"协调团队"};
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([lead, idle]));
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  expect(await screen.findByRole("region", {name:"Lead成员"})).toBeTruthy();
  expect(document.querySelector(".team-live-group-lead .team-compact-row")).toBeTruthy();
  await expand(await screen.findByRole("button", {name:"打开 · Lead · lead"}));
  expect(screen.getByRole("button", {name:"编辑备注 · Lead"})).toBeTruthy();
  expect(screen.getByRole("button", {name:"更新终端"})).toBeTruthy();
  expect(screen.getByRole("button", {name:"从团队移除"})).toBeTruthy();
});

it("keeps a member's details open when it moves to another group", async () => {
  const mover = worker({email:"mover@example.test", role:"m", tmux:{...member.tmux, name:"worker-demo-m"}});
  const ui = (session: AgentSession) => <TeamDynamics sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}} members={[mover]} onUpdated={async()=>{}} board={board} live={liveOf([session])}
    renderMemberAdmin={(m) => <div className="admin-stub">管理 {m.role}</div>}/>;
  const view = render(ui(asSession({session:"worker-demo-m", state:"running", taskCode:"DS-13", taskStatus:"doing"})));
  const row = (await screen.findByRole("button", {name:"打开 · m · worker-demo-m"})).closest(".team-live-row") as HTMLElement;
  await expand(row);
  expect(row.querySelector(".admin-stub")).toBeTruthy();
  // 同一个成员（key 不变）从运行中变成空闲：展开状态保留，管理区仍在
  view.rerender(ui(asSession({session:"worker-demo-m", state:"idle"})));
  const compact = document.querySelector(".team-compact-row") as HTMLDetailsElement;
  await waitFor(() => expect(compact.open).toBe(true));
  expect(compact.querySelector(".admin-stub")).toBeTruthy();
});

it("does not render the empty-card line on a card row without a task", async () => {
  const running = worker({email:"run@example.test", role:"b", tmux:{...member.tmux, name:"worker-demo-b"}});
  const {container} = renderMerged([running], liveOf([asSession({session:"worker-demo-b", state:"running"})]));
  expect(container.querySelector(".team-live-card")).toBeTruthy();
  expect(screen.queryByText("无当前卡")).toBeNull();
  expect(container.querySelectorAll(".team-card-line2")).toHaveLength(0);
});

it("shows the AI summary on the second line when there is no card, and an AI marker when there is one", async () => {
  const note = {aiSummary:"上次修好了 DS-10 的终端输出", aiSource:"s", aiUpdatedAt:new Date().toISOString()};
  const plain = worker({email:"plain@example.test", role:"p", tmux:{...member.tmux, name:"worker-demo-p"}, currentTask:"", ...note, aiSource:JSON.stringify(["remote",22,"dev","/repo","$2",123])});
  const carded = worker({email:"card@example.test", role:"q", tmux:{...member.tmux, name:"worker-demo-q"}, ...note, aiSource:JSON.stringify(["remote",22,"dev","/repo","$2",123])});
  const {container} = renderMerged([plain, carded], liveOf([
    asSession({session:"worker-demo-p", state:"running"}),
    asSession({session:"worker-demo-q", state:"running", taskCode:"DS-13", taskStatus:"doing"}),
  ]));
  expect(container.querySelector(".team-card-line2.is-ai")?.textContent).toContain("上次修好了 DS-10");
  expect(container.querySelectorAll(".team-ai-chip")).toHaveLength(1);
});

it("shows the empty state when the roster only contains the Lead", async () => {
  const lead = {...member, email:"lead@example.test", role:"Lead", tmux:{...member.tmux, name:"lead"}};
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([lead]));
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  await screen.findByRole("region", {name:"Lead成员"});
  expect(screen.getByText("把成员终端放在一起")).toBeTruthy();
});

it("counts only workers in the title and still lists the Lead last", async () => {
  const lead = {...member, email:"lead@example.test", role:"Lead", tmux:{id:"$1", created:100, name:"lead"}};
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([lead, idle]));
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  await screen.findByRole("region", {name:"Lead成员"});
  expect(screen.getByText("团队 · 1 人")).toBeTruthy();          // 口径 = worker 数，不含 Lead
  const groups = [...document.querySelectorAll(".team-live-group")].map(g => g.getAttribute("aria-label"));
  expect(groups[groups.length - 1]).toBe("Lead成员");
});

it("shows and honours the 清除筛选 button", async () => {
  const running = worker({email:"run@example.test", role:"b", tmux:{...member.tmux, name:"worker-demo-b"}});
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  renderMerged([running, idle], liveOf([
    asSession({session:"worker-demo-b", state:"running"}),
    asSession({session:"worker-demo-c", state:"idle"}),
  ]));
  const chip = screen.getByRole("button", {name:"1 可派活"});
  expect(chip.getAttribute("aria-label")).toBe("1 可派活");      // 可读名带空格，而非「1可派活」
  fireEvent.click(chip);
  const clear = screen.getByRole("button", {name:"清除筛选"});
  fireEvent.click(clear);
  expect(screen.queryByRole("button", {name:"清除筛选"})).toBeNull();
  expect(screen.getByRole("region", {name:"运行中成员"})).toBeTruthy();
  expect(screen.getByRole("region", {name:"空闲·可派活成员"})).toBeTruthy();
});

it("does not remember the forced expansion of a filtered group", async () => {
  const idle = worker({email:"idle@example.test", role:"c", tmux:{...member.tmux, name:"worker-demo-c"}});
  renderMerged([idle], liveOf([asSession({session:"worker-demo-c", state:"idle"})]));
  fireEvent.click(screen.getByRole("button", {name:"1 可派活"}));
  const group = screen.getByRole("region", {name:"空闲·可派活成员"});
  expect(group.querySelector("details")?.open).toBe(true);       // 筛选期间强制展开
  fireEvent.click(screen.getByRole("button", {name:"清除筛选"}));
  expect(screen.getByRole("region", {name:"空闲·可派活成员"}).querySelector("details")?.open).toBe(false); // 回到默认折叠
});

it("keeps a pinned row expanded while the shell is editing it", async () => {
  const pinnedMember = worker({email:"pinned@example.test", role:"p", tmux:{...member.tmux, name:"worker-demo-p"}});
  render(<TeamDynamics sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}
    members={[pinnedMember]} onUpdated={async()=>{}} board={board}
    live={liveOf([asSession({session:"worker-demo-p", state:"idle"})])}
    pinnedKeys={[pinnedMember.email]}
    renderMemberAdmin={(m) => <div className="admin-stub">管理 {m.role}</div>}/>);
  const row = document.querySelector(".team-compact-row") as HTMLDetailsElement;
  expect(row.open).toBe(true);
  expect(row.querySelector(".admin-stub")).toBeTruthy();
});


it("opens the pixel room from the collaboration panel with the same room callbacks", async () => {
  const officeSnapshot={version:1 as const,themeId:"one-light",animationEnabled:true,mailAvailability:"unavailable" as const,
    projects:[{id:"demo",name:"demo",sources:[{id:"source",label:"Demo",availability:"ready" as const,notice:"",
      members:[{id:"worker",name:"Worker",isLead:false,status:{state:"working" as const,source:"activity" as const,label:"工作中（成员活动）"},taskText:"Task",taskSource:"manual" as const,paletteKey:"worker"}]}]}]};
  const lead={...member, email:"lead@example.test", role:"Lead", tmux:{id:"$1", created:100, name:"lead"}};
  vi.mocked(invoke).mockImplementation(async (command:string) =>
    command==="collaboration_request" ? JSON.stringify([lead, member]) : "{}");
  const onRoomOpenChange=vi.fn();
  const onPopOut=vi.fn().mockResolvedValue(undefined);
  const navigation={server,servers:[server],onOpen:vi.fn()};
  render(<CollaborationPanel sessionId="ssh" profile={profile} onClose={vi.fn()} teamNavigation={navigation}
    officeSnapshot={officeSnapshot} onRoomOpenChange={onRoomOpenChange} onPopOut={onPopOut}/>);
  // 协作面板里也能看到唯一的房间入口
  const room=await screen.findByRole("button",{name:"房间",exact:true});
  expect(screen.getAllByRole("button",{name:"房间",exact:true})).toHaveLength(1);
  expect(onRoomOpenChange).toHaveBeenLastCalledWith(false);
  // 打开：房间渲染、列表让位
  fireEvent.click(room);
  expect(screen.getByRole("region",{name:"公司办公室"})).toBeTruthy();
  expect(document.querySelector(".team-live-row")).toBeNull();     // 列表让位给房间
  expect(onRoomOpenChange).toHaveBeenLastCalledWith(true);
  // 弹出窗口
  fireEvent.click(screen.getByRole("button",{name:"弹出窗口"}));
  await waitFor(()=>expect(onPopOut).toHaveBeenCalledTimes(1));
  // 再点回列表
  fireEvent.click(screen.getByRole("button",{name:"房间",exact:true}));
  expect(screen.queryByRole("region",{name:"公司办公室"})).toBeNull();
  expect(document.querySelector(".team-live-row")).toBeTruthy();    // 回到列表
  expect(onRoomOpenChange).toHaveBeenLastCalledWith(false);
});
