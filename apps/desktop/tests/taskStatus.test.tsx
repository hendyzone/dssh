import {afterEach,it,expect} from "vitest";
import {ingestTaskOutput,taskSnapshot,removeTask,focusTask,reportTask} from "../src/lib/taskStatus";
afterEach(()=>{while(taskSnapshot().length) taskSnapshot().forEach(t=>removeTask(t.id));focusTask("");});
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
