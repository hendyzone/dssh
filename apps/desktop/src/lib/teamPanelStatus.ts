import type {AgentSession, LiveSessions, LiveStatus} from "./agentSessions";
import type {TeamMember} from "./teamMembers";

/** Assignment is business state; terminal idleness and lease expiry cannot clear it. */
export function teamPanelStatus(member:TeamMember, base:LiveStatus, collector:AgentSession|undefined, live:LiveSessions, lead=false):LiveStatus {
  if(lead)return {...base,group:"lead",label:base.group==="available"?"空闲":base.label};
  const identities=new Set([member.email.trim().toLowerCase(),member.email.split("@")[0].trim().toLowerCase(),member.tmux.name.replace(/^worker-/,"").toLowerCase()].filter(Boolean));
  const assigned=live.tasks?.some(task=>task.project===member.project && task.status_key==="doing" && identities.has(task.assignee.trim().toLowerCase()));
  const working=!!assigned || /^工作中\s*·/.test(member.currentTask?.trim()??"");
  const offline=live.snapshot?.collectorOffline===true || collector?.leaseStatus==="unknown";
  if(working){
    if(base.needsHuman && !offline)return {...base,label:base.label+" · 工作中"};
    return {...base,rank:6,tone:"run",group:"running",label:offline?"工作中 · 采集离线":"工作中",needsHuman:false,duration:""};
  }
  if(offline)return {rank:8,tone:"offline",group:"other",label:"采集离线",needsHuman:false,duration:""};
  if(base.group==="available" && (!/^空闲/.test(member.currentTask?.trim()??"") || !live.taskProjects?.includes(member.project)))
    return {rank:8,tone:"none",group:"other",label:"待确认",needsHuman:false,duration:""};
  return base;
}
