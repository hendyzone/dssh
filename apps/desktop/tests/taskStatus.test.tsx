import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { sendNotification } from "@tauri-apps/plugin-notification";
import {
  ingestTaskOutput as ingestOutput, taskSnapshot, removeTask, focusTask, reportTask,
  acknowledgeTasks, endTaskTerminal, enableDesktopNotifications, programTaskId,
} from "../src/lib/taskStatus";
import { PROGRAM_STATUS_REPLY } from "../src/lib/programStatus";
import tmuxFixture from "./fixtures/osc7501-tmux-3.4.json";

vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(), isPermissionGranted: vi.fn(async () => true), requestPermission: vi.fn(async () => "granted"),
}));

const terminalIds = new Set<string>();
function ingestTaskOutput(...args: Parameters<typeof ingestOutput>) {
  terminalIds.add(args[0]);
  return ingestOutput(...args);
}
const osc = (body: string, terminator = "\x1b\\") => `\x1b]7501;${body}${terminator}`;
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const send = (body: string, pane = "native") => ingestTaskOutput(pane, `Server · ${pane}`, osc(body));
const programRecords = (pane = "native") => taskSnapshot().filter(task => task.protocol === "osc7501" && task.sourcePaneId === pane);

beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
});
afterEach(() => {
  for (const id of terminalIds) removeTask(id);
  terminalIds.clear();
  while (taskSnapshot().length) taskSnapshot().forEach(task => { removeTask(task.sourcePaneId ?? task.id); removeTask(task.id); });
  focusTask("");
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("reassembles tool notifications and marks a background task unread",()=>{focusTask("foreground");ingestTaskOutput("b","demo","\x1b]777;dssh;do");ingestTaskOutput("b","demo","ne;完成\x07");expect(taskSnapshot()[0]).toMatchObject({phase:"done",estimated:false,unread:true});focusTask("b");expect(taskSnapshot()[0].unread).toBe(false);});
it("marks text heuristics as estimates and never treats quiet output as completion",()=>{ingestTaskOutput("a","demo","processing");expect(taskSnapshot()[0]).toMatchObject({phase:"running",estimated:true});ingestTaskOutput("a","demo","Do you want to proceed?");expect(taskSnapshot()[0]).toMatchObject({phase:"waiting",estimated:true});});
it("treats Codex duration text as a turn end rather than task completion",()=>{
  ingestTaskOutput("a","demo","Worked for 23 seconds");
  expect(taskSnapshot()[0]).toMatchObject({phase:"idle",estimated:true});
});
it("keeps authoritative state despite output text and merges the underlying terminal card",()=>{
  ingestTaskOutput("pane","demo","output");
  reportTask("ai","Codex","working","处理中",false,false,1,{provider:"codex",sourcePaneId:"pane"});
  ingestTaskOutput("pane","demo","Do you want to proceed? task completed");
  expect(taskSnapshot()).toHaveLength(1);
  expect(taskSnapshot()[0]).toMatchObject({id:"ai",phase:"working",estimated:false});
  reportTask("ai","Codex","waiting","需要确认",false,true,2,{provider:"codex",sourcePaneId:"pane"});
  expect(taskSnapshot()[0].unread).toBe(true);
  focusTask("pane");
  expect(taskSnapshot()[0].unread).toBe(false);
});
it("keeps pi textual approval fallback visibly estimated until a real event arrives",()=>{
  reportTask("ai","pi","working","处理中",false,false,1,{provider:"pi",sourcePaneId:"pane"});
  ingestTaskOutput("pane","demo","Do you want to proceed?");
  expect(taskSnapshot()[0]).toMatchObject({phase:"waiting",estimated:true,provider:"pi"});
  reportTask("ai","pi","idle","本轮已结束",false,true,2,{provider:"pi",sourcePaneId:"pane"});
  expect(taskSnapshot()[0]).toMatchObject({phase:"idle",estimated:false});
});

it("fully replaces native records and recomputes inherited app without inventing parent records", () => {
  send(`state=working:app=deploy:title=${base64("部署")}:msg=${base64("推送镜像")}:progress=10`);
  send("state=working:id=eu/build:progress=40");
  expect(programRecords()).toHaveLength(2);
  expect(programRecords().find(task => task.recordId === "eu/build")).toMatchObject({
    app: "deploy", progress: 40, phase: "working", estimated: false,
    name: "Server · native", sourcePaneId: "native", protocolScope: "terminal",
  });
  send("state=idle:id=eu:app=terraform");
  expect(programRecords().find(task => task.recordId === "eu/build")?.app).toBe("terraform");
  send("state=blocked:kind=permission");
  expect(programRecords().find(task => task.recordId === "")).toMatchObject({
    phase: "waiting", programState: "blocked", kind: "permission", title: "", message: "",
  });
  expect(programRecords().find(task => task.recordId === "")?.app).toBeUndefined();
  expect(programRecords().find(task => task.recordId === "")?.progress).toBeUndefined();
  send("state=clear:id=eu");
  expect(programRecords().map(task => task.recordId)).toEqual([""]);
});

it("clears only the addressed subtree and lets root clear remove all native rows", () => {
  for (const id of ["", "build", "build/test", "build2"]) send(`state=done${id ? `:id=${id}` : ""}`);
  send("state=clear:id=build");
  expect(programRecords().map(task => task.recordId).sort()).toEqual(["", "build2"]);
  send("state=clear");
  expect(taskSnapshot()).toEqual([]);
});

it.each(["prompt", "exit"] as const)("drops active records at %s while completed and failed results survive", (event) => {
  for (const state of ["idle", "working", "blocked", "done", "error"]) send(`state=${state}:id=${state}`);
  if (event === "prompt") ingestTaskOutput("native", "Server", "\x1b]133;A;aid=1\x07");
  else endTaskTerminal("native");
  expect(programRecords().map(task => task.programState).sort()).toEqual(["done", "error", "idle"]);
  expect(programRecords().find(task => task.programState === "done")?.unread).toBe(true);
  expect(programRecords().find(task => task.programState === "error")?.unread).toBe(true);
});

it("keeps records across screen switches and soft reset but clears them on RIS", () => {
  send("state=working:app=cargo");
  send("state=done:id=test");
  ingestTaskOutput("native", "Server", "\x1b[?1049h\x1b[?1049l\x1b[!p");
  expect(programRecords()).toHaveLength(2);
  ingestTaskOutput("native", "Server", "\x1bc");
  expect(taskSnapshot()).toEqual([]);
  ingestTaskOutput("native", "Server", "ordinary output");
  expect(taskSnapshot()[0]).toMatchObject({ id: "native", phase: "running", estimated: true });
});

it("keeps repeated completed snapshots read and marks a new working-to-done cycle unread", () => {
  focusTask("another-pane");
  send("state=done:app=cargo");
  expect(programRecords()[0].unread).toBe(true);
  acknowledgeTasks();
  send("state=done:app=cargo");
  expect(programRecords()[0].unread).toBe(false);
  send("state=working:app=cargo");
  send("state=done:app=cargo");
  expect(programRecords()[0].unread).toBe(true);
  focusTask(programTaskId("native", ""));
  expect(programRecords()[0].unread).toBe(false);
  send("state=working:app=cargo");
  send("state=done:app=cargo");
  expect(programRecords()[0].unread).toBe(false);
});

it("acknowledges child results through their source terminal without reading another terminal", () => {
  send("state=done:id=left");
  send("state=blocked:kind=question:id=right");
  send("state=done", "other");
  focusTask(programTaskId("native", "right"));
  expect(programRecords().every(task => !task.unread)).toBe(true);
  expect(programRecords("other")[0].unread).toBe(true);
});

it.each([ ["codex", "codex"], ["claude", "claude-code"] ] as const)("prefers native %s reports over the same program's Hooks on ordinary SSH", (provider, app) => {
  reportTask("hook", "Tool", "working", "Hook working", false, false, 1, { provider, sourcePaneId: "native" });
  send(`state=blocked:app=${app}:kind=permission`);
  expect(taskSnapshot()).toHaveLength(1);
  expect(taskSnapshot()[0]).toMatchObject({ protocol: "osc7501", phase: "waiting", kind: "permission" });
  reportTask("hook", "Tool", "idle", "late Hook", false, true, 2, { provider, sourcePaneId: "native" });
  expect(taskSnapshot()).toHaveLength(1);
  expect(taskSnapshot()[0].programState).toBe("blocked");
});

it("allows the next Hook lifecycle after a prompt while preserving the previous native result", () => {
  send("state=done:app=codex");
  ingestTaskOutput("native", "Server", "\x1b]133;A\x07");
  reportTask("new-hook", "Codex", "working", "new run", false, true, 2, { provider: "codex", sourcePaneId: "native" });
  expect(taskSnapshot()).toHaveLength(2);
  expect(taskSnapshot().find(task => task.id === "new-hook")).toMatchObject({ phase: "working", provider: "codex" });
  expect(programRecords()[0].programState).toBe("done");
});

it("keeps a Codex Hook when an independent native child record provides no app identity", () => {
  reportTask("codex-hook", "Codex", "working", "Hook running", false, false, 1, { provider: "codex", sourcePaneId: "native" });
  send("state=blocked:id=build/test:kind=question");
  expect(taskSnapshot()).toHaveLength(2);
  expect(programRecords()[0]).toMatchObject({ recordId: "build/test", programState: "blocked" });
  expect(programRecords()[0].app).toBeUndefined();
  reportTask("codex-hook", "Codex", "waiting", "Hook permission", false, true, 2, { provider: "codex", sourcePaneId: "native" });
  expect(taskSnapshot().find(task => task.id === "codex-hook")).toMatchObject({ phase: "waiting", provider: "codex" });
  expect(programRecords()).toHaveLength(1);
});

it("keeps tmux Hooks alongside passthrough reports and never replies to an unidentified querying pane", () => {
  reportTask("tmux-hook", "Codex · %3", "working", "Hook", false, false, 1, { provider: "codex", sourcePaneId: "tmux" });
  const replies = ingestTaskOutput("tmux", "Server · build", osc("state=blocked:app=codex:kind=auth") + osc("?"), { tmux: true });
  expect(replies).toEqual([]);
  expect(taskSnapshot().find(task => task.id === "tmux-hook")).toMatchObject({ phase: "working" });
  expect(programRecords("tmux")[0]).toMatchObject({ protocolScope: "tmux-client", sourcePaneId: "tmux", phase: "waiting" });
  reportTask("tmux-hook", "Codex · %3", "idle", "Hook settled", false, true, 2, { provider: "codex", sourcePaneId: "tmux" });
  expect(taskSnapshot().find(task => task.id === "tmux-hook")?.phase).toBe("idle");
  expect(programRecords("tmux")[0].programState).toBe("blocked");
  expect(send("?", "plain")).toEqual([PROGRAM_STATUS_REPLY]);
});

it("preserves ANSI-styled pi approval fallback and respects status boundaries in the same chunk", () => {
  reportTask("pi-hook", "pi", "working", "Hook", false, false, 1, { provider: "pi", sourcePaneId: "native" });
  ingestTaskOutput("native", "Server", "Do you want to \x1b[31mproceed?\x1b[0m");
  expect(taskSnapshot()[0]).toMatchObject({ id: "pi-hook", phase: "waiting", estimated: true });
  ingestTaskOutput("native", "Server", "task completed" + osc("state=working:app=pi") + "Do you want to proceed?");
  expect(taskSnapshot()).toHaveLength(1);
  expect(taskSnapshot()[0]).toMatchObject({ protocol: "osc7501", phase: "working", estimated: false });
});

it("never guesses status from invalid control reports or from program message contents", () => {
  ingestTaskOutput("native", "Server", osc("state=unknown:msg=Do you want to proceed?") + osc("state=done:id=bad!"));
  expect(taskSnapshot()).toEqual([]);
  send(`state=working:app=pi:msg=${base64("Do you want to proceed? task completed fatal error")}`);
  expect(programRecords()[0]).toMatchObject({ phase: "working", estimated: false, unread: false });
  send(`state=done:msg=${base64("invalid\ntext")}`);
  expect(programRecords()[0].programState).toBe("working");
  send(`state=done:title=${base64("safe\u202e.exe")}:msg=${base64("result\u200b ready")}`);
  expect(programRecords()[0]).toMatchObject({ title: "safe.exe", message: "result ready" });
});

it("processes native records, clear and prompt in stream order within one transport chunk", () => {
  ingestTaskOutput("native", "Server", osc("state=done:app=cargo") + osc("state=clear") +
    osc("state=blocked:kind=question:id=job") + "\x1b]133;A\x07" + osc("state=error:id=failed"));
  expect(programRecords()).toHaveLength(1);
  expect(programRecords()[0]).toMatchObject({ recordId: "failed", programState: "error", unread: true });
});

it("replays real tmux 3.4 PTY output through the task store, including split transport writes", () => {
  expect(tmuxFixture.tmuxVersion).toBe("tmux 3.4");
  tmuxFixture.chunks.forEach((chunk, index) => {
    for (let offset = 0; offset < chunk.length; offset += 7) {
      expect(ingestTaskOutput("tmux-fixture", "Dev · build", chunk.slice(offset, offset + 7), { tmux: true })).toEqual([]);
    }
    expect(programRecords("tmux-fixture")[0]).toMatchObject({
      programState: tmuxFixture.expectedStates[index], app: "cargo", protocolScope: "tmux-client", sourcePaneId: "tmux-fixture",
    });
  });
  expect(programRecords("tmux-fixture")[0]).toMatchObject({ phase: "done", unread: true });
  endTaskTerminal("tmux-fixture");
  expect(programRecords("tmux-fixture")[0].programState).toBe("done");
});

it("rate-limits native desktop reminders without dropping current state or unread results", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  await enableDesktopNotifications();
  send("state=blocked:kind=permission:app=cargo");
  send("state=blocked:kind=permission:app=cargo:progress=40");
  send("state=done:app=cargo");
  expect(sendNotification).toHaveBeenCalledTimes(1);
  expect(programRecords()[0]).toMatchObject({ phase: "done", unread: true });
  vi.advanceTimersByTime(5000);
  send("state=working:app=cargo");
  send("state=error:app=cargo");
  expect(sendNotification).toHaveBeenCalledTimes(2);
  expect(sendNotification).toHaveBeenLastCalledWith(expect.objectContaining({
    title: "Server · native", extra: { taskId: programTaskId("native", "") },
  }));
});
