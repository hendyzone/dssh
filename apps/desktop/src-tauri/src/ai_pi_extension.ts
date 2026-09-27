// dssh-managed-ai-status-v1
import { execFile } from "node:child_process";

export default function (pi: any) {
  const emit = (event: string, ctx: any) => new Promise<void>(resolve => {
    try {
      const payload = JSON.stringify({ hook_event_name: event, session_id: ctx.sessionManager.getSessionId() });
      execFile(__DSSH_PYTHON__, [__DSSH_HELPER__, "event", "pi", payload],
        { timeout: 1500, maxBuffer: 1024 }, () => resolve());
    } catch { resolve(); }
  });
  for (const event of ["session_start", "agent_start", "session_shutdown", "ui_prompt_start"])
    pi.on(event, (_event: any, ctx: any) => emit(event, ctx));
  pi.on("ui_prompt_end", (_event: any, ctx: any) => emit(ctx.isIdle() ? "session_start" : "ui_prompt_end", ctx));
  pi.on("agent_end", (event: any, ctx: any) => {
    const last = event.messages?.filter((message: any) => message.role === "assistant").at(-1);
    return emit(last?.stopReason === "error" ? "error" : "agent_end", ctx);
  });
}
