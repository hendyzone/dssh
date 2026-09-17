import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TeamMembers from "../src/components/TeamMembers";
import TeamPanel from "../src/components/TeamPanel";
import ToolRail from "../src/components/ToolRail";
import { emptyProfile } from "../src/lib/collaboration";
import { connectedMemberTab, matchingServers, parseMember, type TeamMember } from "../src/lib/teamMembers";
import type { ServerEntry } from "../src/types";

vi.mock("@tauri-apps/api/core", () => ({invoke:vi.fn()}));
const member:TeamMember = {project:"demo", email:"worker@example.test", role:"cw2", host:"remote", port:22, username:"dev", workdir:"/repo", tmux:{id:"$2", created:123, name:"worker"}};
const server:ServerEntry = {id:"local-device-id", name:"开发机", host:"remote", port:22, username:"dev", authMethod:"password"};
const profile = {...emptyProfile(), enabled:true, taskboardEnabled:true, project:"demo", workdir:"/lead", tmuxId:"$1", tmuxCreated:100, tmuxName:"lead", taskboardUrl:"https://board.test"};
beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset().mockResolvedValue(JSON.stringify([member])); });

it("portable positions strip secrets and local IDs, reject foreign projects and reused identities", () => {
  expect(parseMember({...member, password:"secret", serverId:"old-device"}, "demo")).toEqual(member);
  for (const invalid of [{...member, project:"other"}, {...member, tmux:{...member.tmux, created:0}}, {...member, port:70000}, {...member, workdir:"relative"}]) {
    expect(() => parseMember(invalid, "demo")).toThrow();
  }
  expect(matchingServers(member, [server, {...server, id:"root", username:"root"}, {...server, id:"other-port", port:2222}])).toEqual([server]);
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
  await screen.findByText("cw2");
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
  fireEvent.change(screen.getByLabelText("项目名称"),{target:{value:"demo"}});
  fireEvent.click(screen.getByRole("button",{name:"打开此项目的团队"}));
  await screen.findByRole("button",{name:"添加成员"});
  const saved=Object.values(JSON.parse(localStorage.getItem("dssh.collaboration.v2")!))[0];
  expect(saved).toMatchObject({enabled:true,membersEnabled:true,mailEnabled:false,taskboardEnabled:false,workdir:"/lead/repo"});
});
