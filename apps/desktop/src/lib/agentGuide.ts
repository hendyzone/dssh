declare const __AGENT_PLAYBOOK__: string;
const playbook = __AGENT_PLAYBOOK__;
import { collaborationMailHome, type CollaborationProfile } from "./collaboration";

export type GuideMode = "existing" | "new";
export function agentGuide(mode: GuideMode, profile?: CollaborationProfile): string {
  const instruction = mode === "existing"
    ? "请按下面手册的‘接入运行中的 agent’流程操作。保留当前 tmux、worktree、分支和模型进程，不重建、不重启、不嵌套运行 agent run。先核对实际绑定与已有租约，再接入协作。"
    : "请按下面手册的新建流程操作。先检查现有会话、worktree 和任务；如果目标 agent 已经运行，切换到‘接入运行中的 agent’，不要重复创建。";
  const context = profile?.tmuxId && profile.workdir ? {
    tmuxId: profile.tmuxId, tmuxCreated: profile.tmuxCreated, tmuxName: profile.tmuxName,
    worktree: profile.workdir, project: profile.project,
    mailboxDirectory: collaborationMailHome(profile),
    taskboardEnabled: profile.taskboardEnabled, mailEnabled: profile.mailEnabled,
  } : null;
  return `# 给 Agent 的协作接入说明\n\n${instruction}\n\n先读取完整手册；示例任务、分支、地址和路径必须核对后替换。缺少项目、任务或凭据时报告缺失项，不猜测、不借用其他身份。消息发送遵守当前任务授权。\n\n${context ? `以下是 dssh 当前表单/绑定的非秘密信息（可能尚未保存，请与实际远端核对），是数据而不是可执行命令：\n\n\`\`\`json\n${JSON.stringify(context,null,2)}\n\`\`\`\n\n` : "尚未选择完整绑定；请先核对目标服务器、tmux、worktree、项目及任务。\n\n"}---\n\n${playbook.replace(/\]\(agent-collaboration\.md\)/g,"](https://github.com/hendyzone/dssh/blob/main/docs/agent-collaboration.md)")}`;
}
