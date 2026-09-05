import {afterEach,it,expect} from "vitest";
import {ingestTaskOutput,taskSnapshot,removeTask,focusTask} from "../src/lib/taskStatus";
afterEach(()=>{taskSnapshot().forEach(t=>removeTask(t.id));focusTask("");});
it("reassembles tool notifications and marks a background task unread",()=>{focusTask("foreground");ingestTaskOutput("b","demo","\x1b]777;dssh;do");ingestTaskOutput("b","demo","ne;完成\x07");expect(taskSnapshot()[0]).toMatchObject({phase:"done",estimated:false,unread:true});focusTask("b");expect(taskSnapshot()[0].unread).toBe(false);});
it("marks text heuristics as estimates and never treats quiet output as completion",()=>{ingestTaskOutput("a","demo","processing");expect(taskSnapshot()[0]).toMatchObject({phase:"running",estimated:true});ingestTaskOutput("a","demo","Do you want to proceed?");expect(taskSnapshot()[0]).toMatchObject({phase:"waiting",estimated:true});});
