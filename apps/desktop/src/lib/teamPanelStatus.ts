import type {AgentSession, LiveSessions, LiveStatus} from "./agentSessions";
import {taskInMemberScope} from "./taskLookup";
import type {TeamMember} from "./teamMembers";

function memberAssigneeKeys(member: TeamMember): Set<string> {
  return new Set([member.email.trim().toLowerCase(), member.email.split("@")[0].trim().toLowerCase(), member.tmux.name.replace(/^worker-/,"").toLowerCase()].filter(Boolean));
}

/** Doing card from the board index (including child projects of the roster project). */
export function memberDoingTaskFromIndex(member: TeamMember, live: Pick<LiveSessions, "tasks" | "parentBy">): {project:string;code:string}|undefined {
  const identities = memberAssigneeKeys(member);
  const parentBy = live.parentBy ?? {};
  const task = live.tasks?.find(entry => entry.status_key === "doing" && identities.has(entry.assignee.trim().toLowerCase())
    && taskInMemberScope(entry.project, member.project, parentBy));
  return task ? { project: task.project, code: task.code } : undefined;
}

/** Assignment is business state; terminal idleness and lease expiry cannot clear it. */
export function teamPanelStatus(member:TeamMember, base:LiveStatus, collector:AgentSession|undefined, live:LiveSessions, lead=false):LiveStatus {
  if(lead)return {...base,group:"lead",label:base.group==="available"?"空闲":base.label};
  const identities = memberAssigneeKeys(member);
  const parentBy = live.parentBy ?? {};
  const assigned=live.tasks?.some(task=>task.status_key==="doing" && identities.has(task.assignee.trim().toLowerCase())
    && taskInMemberScope(task.project, member.project, parentBy));
  const working=!!assigned || /^工作中\s*·/.test(member.currentTask?.trim()??"");
  const offline=live.snapshot?.collectorOffline===true || collector?.leaseStatus==="unknown";
  if(working){
    if(base.needsHuman && !offline)return {...base,label:base.label+" · 工作中"};
    return {...base,rank:6,tone:"run",group:"running",label:offline?"工作中 · 采集离线":"工作中",needsHuman:false,duration:""};
  }
  if(offline)return {rank:8,tone:"offline",group:"other",label:"采集离线",needsHuman:false,duration:""};
  const projects = live.taskProjects ?? [];
  const indexReady = projects.length > 0 && (projects.includes(member.project)
    || Object.keys(parentBy).some(child => parentBy[child] === member.project && projects.includes(child)));
  if(base.group==="available" && (!/^空闲/.test(member.currentTask?.trim()??"") || !indexReady))
    return {rank:8,tone:"none",group:"other",label:"待确认",needsHuman:false,duration:""};
  return base;
}
