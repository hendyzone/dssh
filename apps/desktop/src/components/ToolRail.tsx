import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { useEffect, useState } from "react";
import {
  IconFolder,
  IconForward,
  IconTasks,
  IconChanges,
  IconMonitor,
} from "./Icons";
export default function ToolRail({
  side,
  active,
  onSelect,
  collaborationEnabled = false,
}: {
  side: "left" | "right";
  active: string | null;
  collaborationEnabled?: boolean;
  onSelect: (
    kind: "sftp" | "tmux" | "forward" | "tasks" | "changes" | "monitor" | "collaboration",
  ) => void;
}) {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((v) => v + 1);
    window.addEventListener("dssh-panel-position", update);
    return () => window.removeEventListener("dssh-panel-position", update);
  }, []);
  void revision;
  return (
    <TooltipProvider delayDuration={350}>
      <nav
        className={"tool-rail tool-rail-" + side}
        aria-label={side === "left" ? "左侧工具" : "右侧工具"}
      >
        {(["sftp", "tmux", "forward", "tasks", "changes", "monitor", "collaboration"] as const)
          .filter(kind => kind !== "collaboration" || collaborationEnabled)
          .filter(
            (kind) =>
              (localStorage.getItem("dssh.panel-side." + kind) === "left"
                ? "left"
                : "right") === side,
          )
          .map((kind) => (
            <Tooltip key={kind}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={active === kind ? "active" : ""}
                  aria-pressed={active === kind}
                  aria-label={
                    {
                      sftp: "文件 · SFTP",
                      tmux: "tmux 会话",
                      forward: "端口转发",
                      tasks: "任务状态与提醒",
                      changes: "代码修改",
                      monitor: "服务器监控",
                      collaboration: "Agent 协作",
                    }[kind]
                  }
                  onClick={() => onSelect(kind)}
                >
                  {kind === "sftp" ? (
                    <IconFolder />
                  ) : kind === "forward" ? (
                    <IconForward />
                  ) : (
                    <>
                      {kind === "tasks" ? (
                        <IconTasks />
                      ) : kind === "changes" ? (
                        <IconChanges />
                      ) : kind === "monitor" ? (
                        <IconMonitor />
                      ) : (
                        <span>{kind === "collaboration" ? "协" : "tm"}</span>
                      )}
                    </>
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent
                side={side === "right" ? "left" : "right"}
                sideOffset={10}
              >
                {
                  {
                    sftp: "文件 · SFTP",
                    tmux: "tmux 会话",
                    forward: "端口转发",
                    tasks: "任务状态与提醒",
                    changes: "代码修改",
                    monitor: "服务器监控",
                    collaboration: "Agent 协作",
                  }[kind]
                }
              </TooltipContent>
            </Tooltip>
          ))}
      </nav>
    </TooltipProvider>
  );
}
