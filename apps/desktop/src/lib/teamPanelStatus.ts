import {liveSnapshot, rankMembers, type AgentSession, type LiveSessions, type LiveStatus} from "./agentSessions";
import {taskInMemberScope} from "./taskLookup";
import {memberKey, type TeamMember} from "./teamMembers";
import type {TeamLive} from "./teamService";
import {serviceMemberStatus} from "./teamServicePresentation";
import {activityStatus, CARD_IDLE_ALERT_SECONDS, type ServiceActivity} from "./memberActivity";
import type {IndexTask} from "./taskLookup";

function memberAssigneeKeys(member: TeamMember): Set<string> {
  return new Set([member.email.trim().toLowerCase(), member.email.split("@")[0].trim().toLowerCase(), member.tmux.name.replace(/^worker-/,"").toLowerCase()].filter(Boolean));
}

/** Every doing card of the member on the board index (including child projects of the roster project). */
export function memberDoingTasks(member: TeamMember, live: Pick<LiveSessions, "tasks" | "parentBy">): (IndexTask & {project:string})[] {
  const identities = memberAssigneeKeys(member);
  const parentBy = live.parentBy ?? {};
  return (live.tasks ?? []).filter(entry => entry.status_key === "doing" && identities.has(entry.assignee.trim().toLowerCase())
    && taskInMemberScope(entry.project, member.project, parentBy));
}
/** First doing card from the board index. */
export function memberDoingTaskFromIndex(member: TeamMember, live: Pick<LiveSessions, "tasks" | "parentBy">): {project:string;code:string}|undefined {
  const task = memberDoingTasks(member, live)[0];
  return task ? { project: task.project, code: task.code } : undefined;
}

/**
 * Which card and whether it is being worked on are two separate facts (plan §3.4): a doing card no
 * longer forces 「工作中」. With an activity from the team service the status is that activity; the
 * card only raises attention (card + idle, card + stalled). Without one the pane status stays.
 */
export function teamPanelStatus(member:TeamMember, base:LiveStatus, collector:AgentSession|undefined, live:LiveSessions, lead=false, activity?:ServiceActivity, stateSince=0):LiveStatus {
  const now=live.snapshot?.now??Date.now()/1000;
  const fromActivity=activity && activityStatus(activity, !lead && memberDoingTasks(member, live).length>0, now, lead);
  if(fromActivity)return fromActivity;
  if(lead)return {...base,group:"lead",label:base.group==="available"?"空闲":base.label};
  const assigned=memberDoingTasks(member, live).length>0;
  const offline=live.snapshot?.collectorOffline===true || collector?.leaseStatus==="unknown";
  if(offline)return {rank:8,tone:"offline",group:"other",label:"采集离线",needsHuman:false,duration:""};
  // Same 10-minute grace as with an activity; without a known start time the card is flagged at once.
  const idleLongEnough=!(stateSince>0) || now-stateSince>=CARD_IDLE_ALERT_SECONDS;
  if(assigned && base.group==="available" && idleLongEnough)
    return {...base,rank:3,tone:"warn",group:"attention",label:base.label.replace(/·可派活$/,"")+" · 有卡未动",needsHuman:true,
      title:"有进行中的卡，但会话空闲：交付后忘了移卡，或卡住了没表现出来"};
  const parentBy = live.parentBy ?? {};
  const projects = live.taskProjects ?? [];
  const indexReady = projects.length > 0 && (projects.includes(member.project)
    || Object.keys(parentBy).some(child => parentBy[child] === member.project && projects.includes(child)));
  // Only an unknown board index makes availability uncertain; a hand-written note never does (dssh/T94).
  if(base.group==="available" && !indexReady)
    return {rank:8,tone:"none",group:"other",label:"待确认",needsHuman:false,duration:""};
  return base;
}

type TeamRow = {member:TeamMember;session?:AgentSession;status:LiveStatus};
/** A worker row of the team list: collector status, then the team service report, then assignment. */
export function presentTeamRow<R extends TeamRow>(row:R, serviceLive:Record<string,TeamLive>|undefined, live:LiveSessions, lead=false):R {
  const original=row.session;
  const report=serviceLive?.[memberKey(row.member)];
  const presented:R=serviceLive===undefined || report?.match==="no_agent" ? row : {
    ...row,...serviceMemberStatus(row.member,report,row.session,liveSnapshot(live)?.now??Date.now()/1000,lead),
  };
  return {...presented,status:teamPanelStatus(row.member,presented.status,original,live,lead,report?.activity,presented.session?.stateSince)};
}
/** The Lead entry of the team toolbar. */
export function teamLeadStatus(member:TeamMember, serviceLive:Record<string,TeamLive>|undefined, live:LiveSessions):LiveStatus {
  return serviceMemberStatus(member,serviceLive?.[memberKey(member)],undefined,liveSnapshot(live)?.now??Date.now()/1000,true).status;
}
/** One member's status dot, read exactly as the team panel shows that member. */
export function teamMemberStatus(member:TeamMember, {serviceLive, live, lead}:{serviceLive?:Record<string,TeamLive>;live:LiveSessions;lead:boolean}):LiveStatus {
  if(lead)return teamLeadStatus(member,serviceLive,live);
  return presentTeamRow(rankMembers([member],liveSnapshot(live))[0],serviceLive,live).status;
}
