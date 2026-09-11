import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import AgentGuide from "../src/components/AgentGuide";
import CollaborationSettings from "../src/components/CollaborationSettings";
import { emptyProfile } from "../src/lib/collaboration";
import { agentGuide } from "../src/lib/agentGuide";

vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
const writeText=vi.fn();
beforeEach(()=>{vi.mocked(invoke).mockReset();writeText.mockReset();Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});});

it("offers the offline guide before connection or activation and only copies on request",async()=>{
  render(<CollaborationSettings/>);
  expect(writeText).not.toHaveBeenCalled();expect(invoke).not.toHaveBeenCalled();
  writeText.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button",{name:"复制给 Agent"}));
  await screen.findByText(/已复制完整手册/);
  const text=writeText.mock.calls[0][0];
  expect(text).toContain("保留当前 tmux");
  expect(text).toContain("git -C");expect(text).toContain("mailctl");expect(text).toContain("接入运行中的 agent");
  expect(invoke).not.toHaveBeenCalled();
});

it("copies the selected mode and whitelisted binding fields without credentials",async()=>{
  const profile={...emptyProfile(),tmuxId:"$5",tmuxCreated:123,tmuxName:"claude",workdir:"/worktree/a",project:"demo",tokenFile:"private-token-file",taskboardUrl:"https://secret-user:secret-password@example.test"};
  render(<AgentGuide profile={profile}/>);
  fireEvent.change(screen.getByLabelText("接入方式"),{target:{value:"new"}});
  fireEvent.click(screen.getByRole("button",{name:"复制给 Agent"}));
  await waitFor(()=>expect(writeText).toHaveBeenCalledTimes(1));
  const text=writeText.mock.calls[0][0];
  expect(text).toContain("请按下面手册的新建流程");
  expect(text).toContain('"tmuxId": "$5"');expect(text).toContain("/worktree/a/.dssh/agents/tmux-5-123");
  expect(text).not.toContain("private-token-file");expect(text).not.toContain("secret-password");
});

it("opens a selectable full text fallback when clipboard access fails",async()=>{
  writeText.mockRejectedValue(new Error("denied"));
  render(<AgentGuide/>);
  fireEvent.click(screen.getByRole("button",{name:"复制给 Agent"}));
  await screen.findByText(/剪贴板不可用/);
  const text=screen.getByLabelText("Agent 手册 Markdown") as HTMLTextAreaElement;
  // Textarea values normalize Windows line endings to LF.
  expect(text.value).toBe(agentGuide("existing").replace(/\r\n?/g, "\n"));
  expect(text.closest("details")?.open).toBe(true);
});

it("saves the same complete Markdown via a local save dialog and reports cancellation",async()=>{
  vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce("C:/guide.md");
  render(<AgentGuide/>);
  fireEvent.click(screen.getByRole("button",{name:"保存 Markdown"}));
  await screen.findByText("已取消保存。");
  expect(invoke).toHaveBeenCalledWith("collaboration_export_guide",{content:agentGuide("existing")});
  fireEvent.click(screen.getByRole("button",{name:"保存 Markdown"}));
  await screen.findByText("已保存：C:/guide.md");
});
