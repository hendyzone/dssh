import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TeamMembers from "../src/components/TeamMembers";
import TeamPanel from "../src/components/TeamPanel";
import ToolRail from "../src/components/ToolRail";
import { teamLeadPrompt } from "../src/lib/teamLeadPrompt";
import { collaborationKey, emptyProfile, loadCollaboration, saveCollaboration } from "../src/lib/collaboration";
import { connectedMemberTab, matchingServers, parseMember, type TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn()}));
const member:TeamMember = {project:"demo", email:"worker@example.test", role:"cw2", host:"remote", port:22, username:"dev", workdir:"/repo", tmux:{id:"$2", created:123, name:"worker"}};
const server:ServerEntry = {id:"local-device-id", name:"开发机", host:"remote", port:22, username:"dev", authMethod:"password"};
const profile = {...emptyProfile(), enabled:true, taskboardEnabled:true, project:"demo", workdir:"/lead", tmuxId:"$1", tmuxCreated:100, tmuxName:"lead", taskboardUrl:"https://board.test"};
beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset().mockResolvedValue(JSON.stringify([member])); });

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
  await screen.findByRole("button",{name:"打开终端 · cw2"});
  const count=vi.mocked(invoke).mock.calls.length;
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
  await screen.findByText("后端",{exact:false});
  expect(screen.getByLabelText("成员摘要").textContent).toContain("T12 测试中");
  expect(screen.getByText("详细信息").closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("管理"));
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
  fireEvent.click(await screen.findByRole("button", {name:"打开终端 · cw2"}));
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(member, server));
  expect(invoke).toHaveBeenCalledWith("collaboration_request", {sessionId:"lead-ssh", profile, request:{operation:"members", body:""}});
});

it("requires an explicit alias mapping when no endpoint matches and remembers it locally", async () => {
  const alias = {...server, host:"100.66.1.5"};
  const onOpen = vi.fn().mockResolvedValue(undefined);
  const props = {sessionId:"lead-ssh", profile, navigation:{server, servers:[alias], onOpen}};
  const view = render(<TeamMembers {...props}/>);
  const button = await screen.findByRole("button", {name:"打开终端 · cw2"});
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("本机连接 · cw2"), {target:{value:alias.id}});
  fireEvent.click(button);
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(member, alias));
  view.unmount();
  render(<TeamMembers {...props}/>);
  fireEvent.click(await screen.findByRole("button",{name:"管理"}));
  expect((await screen.findByLabelText("本机连接 · cw2") as HTMLSelectElement).value).toBe(alias.id);
});

it("reports stale sessions and never silently retargets a member", async () => {
  const onOpen = vi.fn().mockRejectedValue(new Error("成员会话已结束"));
  render(<TeamMembers sessionId="lead-ssh" profile={profile} navigation={{server, servers:[server], onOpen}}/>);
  fireEvent.click(await screen.findByRole("button", {name:"打开终端 · cw2"}));
  expect((await screen.findByRole("alert")).textContent).toContain("成员会话已结束");
  expect(onOpen).toHaveBeenCalledTimes(1);
});

it("registers only validated location fields and does not send agent messages", async () => {
  render(<TeamMembers sessionId="lead-ssh" profile={profile} navigation={{server, servers:[server], onOpen:vi.fn()}}/>);
  await screen.findByRole("button",{name:"打开终端 · cw2"});
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
  const original={...server,id:"old-route",host:"100.66.1.7"};
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

it("groups current work ahead of idle members without inferring unknown status",async()=>{
  vi.mocked(invoke).mockResolvedValue(JSON.stringify([
    {...member,role:"空闲成员",currentTask:"空闲116h，无在飞卡"},
    {...member,email:"busy@example.test",role:"工作成员",currentTask:"T762等待验收"},
    {...member,email:"unknown@example.test",role:"未知成员",currentTask:"待确认\n历史：空闲"},
  ]));
  render(<TeamMembers sessionId="ssh" profile={profile} navigation={{server,servers:[server],onOpen:vi.fn()}}/>);
  const working=await screen.findByRole("region",{name:"工作中成员"});
  expect(working.textContent).toContain("工作成员");
  expect(screen.getByRole("region",{name:"空闲成员"}).textContent).toContain("空闲成员");
  expect(screen.getByRole("region",{name:"待确认成员"}).textContent).toContain("未知成员");
  expect(screen.getAllByRole("region").map(el=>el.getAttribute("aria-label"))).toEqual(["团队成员","团队动态","工作中成员","空闲成员","待确认成员"]);
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
