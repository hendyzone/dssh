import { fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { COLLABORATION_KEY, collaborationKey, collaborationMailHome, collaborationRequest, emptyProfile, loadCollaboration, saveCollaboration, useActiveCollaboration, type CollaborationProfile } from "../src/lib/collaboration";
import CollaborationPanel from "../src/components/CollaborationPanel";
import CollaborationSettings from "../src/components/CollaborationSettings";
import ToolRail from "../src/components/ToolRail";
import type { ServerEntry } from "../src/types";

vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
beforeEach(()=>vi.mocked(invoke).mockReset());
const profile=():CollaborationProfile=>({...emptyProfile(),tmuxId:"$1",tmuxCreated:123,tmuxName:"claude",enabled:true,taskboardEnabled:true,mailEnabled:true,project:"demo",workdir:"/repo",taskboardUrl:"https://board.example.test",mailctlPath:"/srv/amail/client/mailctl.py"});
const server:ServerEntry={id:"s1",name:"开发机",host:"dev.example.test",port:22,username:"dev",authMethod:"password"};

describe("optional collaboration",()=>{
  it("isolates tmux incarnations and worktrees on the same server, ignoring legacy server settings",()=>{
    localStorage.setItem("dssh.collaboration.v1",JSON.stringify({s1:profile()}));
    expect(loadCollaboration()).toEqual({});
    const profiles=[profile(),{...profile(),tmuxId:"$2"},{...profile(),tmuxCreated:124},{...profile(),workdir:"/other"}];
    profiles.forEach(p=>saveCollaboration("s1",p));
    expect(Object.keys(loadCollaboration())).toHaveLength(4);
    expect(new Set(profiles.map(collaborationMailHome)).size).toBe(4);
  });
  it("selects the current remote worktree and drops stale results when switching panes",async()=>{
    const p=profile(); const other={...p,workdir:"/other"};
    const profiles={[collaborationKey("s1",p)]:p,[collaborationKey("s1",other)]:other};
    const pane={id:"pane",server,tmux:{id:"$1",created:123,name:"claude"}};
    vi.mocked(invoke).mockResolvedValueOnce("/other");
    const hook=renderHook(({backendId})=>useActiveCollaboration(profiles,pane,backendId,"/repo"),{initialProps:{backendId:"ssh1"}});
    await waitFor(()=>expect(hook.result.current).toEqual(other));
    let resolve!:(s:string)=>void;
    vi.mocked(invoke).mockReturnValueOnce(new Promise(r=>{resolve=r;}));
    hook.rerender({backendId:"ssh2"});
    expect(hook.result.current).toBeUndefined();
    resolve("/repo");
    await waitFor(()=>expect(hook.result.current).toEqual(p));
    hook.unmount();
  });
  it("does not discover remote worktrees for disabled or unrelated sessions",()=>{
    const p={...profile(),enabled:false};
    const pane={id:"pane",server,tmux:{id:"$1",created:123,name:"claude"}};
    renderHook(()=>useActiveCollaboration({[collaborationKey("s1",p)]:p},pane,"ssh",undefined));
    expect(invoke).not.toHaveBeenCalled();
  });
  it("defaults to off and does not expose a tool or invoke services",async()=>{
    expect(loadCollaboration()).toEqual({});
    render(<><ToolRail side="right" active={null} onSelect={()=>{}}/><CollaborationPanel sessionId="ssh" profile={emptyProfile()} onClose={()=>{}}/></>);
    expect(screen.queryByRole("button",{name:"Agent 协作"})).toBeNull();
    await expect(collaborationRequest("ssh",emptyProfile(),{operation:"context"})).rejects.toThrow("未开启");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("fails closed for corrupt or incomplete enabled profiles",()=>{
    localStorage.setItem(COLLABORATION_KEY,'{"s1":{"enabled":true,"taskboardEnabled":true}}');
    expect(loadCollaboration().s1.enabled).toBe(false);
    localStorage.setItem(COLLABORATION_KEY,"bad json");expect(loadCollaboration()).toEqual({});
    localStorage.setItem(COLLABORATION_KEY,'{"s1":{"enabled":"true"}}');expect(loadCollaboration().s1.enabled).toBe(false);
  });
  it("saves profiles independently and rejects incomplete activation",()=>{
    expect(()=>saveCollaboration("s1",{...emptyProfile(),enabled:true})).toThrow();
    saveCollaboration("s1",profile());saveCollaboration("s2",{...profile(),enabled:false});
    expect(loadCollaboration()[collaborationKey("s1",profile())].enabled).toBe(true);expect(loadCollaboration()[collaborationKey("s2",profile())].enabled).toBe(false);
    saveCollaboration("s1",{...profile(),enabled:false});expect(loadCollaboration()[collaborationKey("s1",profile())].enabled).toBe(false);
  });
  it("saving disabled configuration never calls a service",()=>{
    render(<CollaborationSettings sessions={[{pane:{id:"pane",server,tmux:{id:"$1",created:123,name:"claude"}},backendId:"ssh"}]}/>);
    expect((screen.getByLabelText("开启此会话 + worktree 的 Agent 协作") as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByLabelText("worktree 根目录"),{target:{value:"/repo"}});
    fireEvent.click(screen.getByRole("button",{name:"保存协作配置"}));
    expect(loadCollaboration()[collaborationKey("s1",profile())].enabled).toBe(false);expect(invoke).not.toHaveBeenCalled();
  });
  it("only loads context after enabled and connected, then shows handoff",async()=>{
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({project:{note:"项目背景"},tasks:[{id:"1",code:"T1",title:"修复重连",status_key:"doing",summary:"处理中"}],leases:[{task_code:"T1",agent:"Claude/A"}],checkpoints:[{id:1,task_code:"T1",summary:"实现退避重试",next_step:"验证断网恢复"}]}));
    render(<CollaborationPanel sessionId="ssh" profile={profile()} onClose={()=>{}}/>);
    expect(await screen.findByText("实现退避重试")).toBeTruthy();
    expect(screen.getByText("下一步：验证断网恢复")).toBeTruthy();
    expect(invoke).toHaveBeenCalledWith("collaboration_request",{sessionId:"ssh",profile:profile(),request:{operation:"context"}});
    expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
  });
  it("requires a preview and explicit send; editing invalidates the preview",async()=>{
    const p={...profile(),taskboardEnabled:false};
    const previewMessage={project:"demo",task:"T1",kind:"request",recipients:["pi@example.test"]};
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({dry_run:true,message:{...previewMessage,body:"请审查"}})).mockResolvedValueOnce(JSON.stringify({dry_run:true,message:{...previewMessage,body:"请审查新版本"}})).mockResolvedValueOnce('{"status":"submitted"}');
    render(<CollaborationPanel sessionId="ssh" profile={p} onClose={()=>{}}/>);
    fireEvent.change(screen.getByLabelText("任务编号"),{target:{value:"T1"}});
    fireEvent.change(screen.getByLabelText("收件邮箱"),{target:{value:"pi@example.test"}});
    fireEvent.change(screen.getByLabelText("消息正文"),{target:{value:"请审查"}});
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"预览消息"}));
    await screen.findByRole("button",{name:"发送预览中的消息"});
    expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({request:{preview:true}});
    fireEvent.change(screen.getByLabelText("消息正文"),{target:{value:"请审查新版本"}});
    expect(screen.queryByRole("button",{name:"发送预览中的消息"})).toBeNull();
    fireEvent.click(screen.getByRole("button",{name:"预览消息"}));
    fireEvent.click(await screen.findByRole("button",{name:"发送预览中的消息"}));
    await screen.findByText(/消息已提交邮件服务器/);
    expect(vi.mocked(invoke).mock.calls[2][1]).toMatchObject({request:{preview:false,body:"请审查新版本",to:"pi@example.test",task:"T1"}});
  });
  it("discard responses after disabling and never invokes when disconnected",async()=>{
    let resolve!:(v:string)=>void;
    vi.mocked(invoke).mockReturnValue(new Promise(r=>{resolve=r;}));
    const view=render(<CollaborationPanel sessionId="ssh" profile={profile()} onClose={()=>{}}/>);
    await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));
    view.rerender(<CollaborationPanel sessionId="" profile={emptyProfile()} onClose={()=>{}}/>);
    resolve('{"project":{"note":"stale context"},"tasks":[]}');
    await waitFor(()=>expect(screen.queryByText("stale context")).toBeNull());
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("does not offer send after an invalid remote preview",async()=>{
    vi.mocked(invoke).mockResolvedValue('{"message":"old client output"}');
    render(<CollaborationPanel sessionId="ssh" profile={{...profile(),taskboardEnabled:false}} onClose={()=>{}}/>);
    fireEvent.change(screen.getByLabelText("任务编号"),{target:{value:"T1"}});
    fireEvent.change(screen.getByLabelText("收件邮箱"),{target:{value:"pi@example.test"}});
    fireEvent.change(screen.getByLabelText("消息正文"),{target:{value:"hello"}});
    fireEvent.click(screen.getByRole("button",{name:"预览消息"}));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button",{name:"发送预览中的消息"})).toBeNull();
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
