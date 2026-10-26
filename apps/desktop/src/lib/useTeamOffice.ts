import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { emptyProfile, type CollaborationProfile, type CollaborationSession } from "./collaboration";
import { briefKey, fetchAgentSessions, matchSession, taskBrief } from "./agentSessions";
import { boardSource, isIdentifier, type TaskLookupSettings } from "./taskLookup";
import { useTeamService } from "./teamService";
import { buildOfficeMailDirectory, type OfficeMailDirectory, buildOfficeSnapshot, officeTeamSources, officeKey, type OfficeTeamSource, type OfficeBoard, type OfficeRoster, type OfficeSnapshot } from "./teamOffice";
import type { TmuxProgramSnapshot } from "./tmuxProgramStatus";
import type { ServerEntry } from "../types";

/** Main-window service roster plus optional, demand-driven taskboard enrichment. */
export function useTeamOffice({ profiles, servers, sessions, lookupSettings, themeId, animationEnabled, enabled = false, officeExists = false, mailDirectoryRef }: {
  profiles: Record<string, CollaborationProfile>; servers: ServerEntry[]; sessions: CollaborationSession[];
  programSnapshots: Record<string, TmuxProgramSnapshot>; lookupSettings: TaskLookupSettings;
  themeId: string; animationEnabled: boolean; enabled?: boolean; officeExists?: boolean; mailDirectoryRef?: MutableRefObject<OfficeMailDirectory>;
}) {
  const service=useTeamService();
  const active=enabled||officeExists;
  const stable=useRef<{content:string;snapshot:OfficeSnapshot}>({content:"",snapshot:{version:1,themeId,animationEnabled,mailAvailability:"unavailable",projects:[]}});
  const [boards,setBoards]=useState<Record<string,OfficeBoard>>({});
  const routeKey=active?JSON.stringify([profiles,servers,sessions,service.url,service.projects]):"";
  const sources=useMemo<OfficeTeamSource[]>(()=>{
    if(!active||!service.url)return [];
    const routes=officeTeamSources(profiles,servers,sessions);
    return service.projects.map(project=>{
      const candidates=routes.filter(route=>route.project===project);
      // Legacy bindings can enrich tasks, but never choose roster identity or block display.
      const route=candidates.length===1?candidates[0]:undefined;
      return {id:officeKey(JSON.stringify([service.url,project])),project,label:project,service:true,
        profile:route?.profile??{...emptyProfile(),project},server:route?.server,backendId:route?.backendId};
    });
  },[routeKey,active]);
  const rosterKey=active?JSON.stringify(service.snapshots):"";
  const rosters=useMemo<Record<string,OfficeRoster>>(()=>Object.fromEntries(sources.map(source=>{
    const team=service.snapshots[source.project];
    const state=service.status.state;
    let notice="";
    if(state==="unauthorized")notice="团队服务令牌已失效，请重新配置";
    else if(state==="offline"||team?.offline)notice=`团队服务离线 · ${team?.receivedAt ? `数据截至 ${new Date(team.receivedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false})}`:"数据时间未知"}`;
    else if(state==="error")notice="团队服务暂不可用，请检查服务配置";
    else if(!team)notice="正在读取团队服务…";
    return [source.id,{members:team?.members??[],live:team?.live??{},ai:team?.ai??{},machines:team?.machines??{},aiEnabled:service.status.ai_enabled,availability:team?(state==="online"?"ready":"offline"):state==="error"?"error":"loading",notice} satisfies OfficeRoster];
  })),[sources,rosterKey,service.status.state,service.status.ai_enabled]);
  const boardKey=active?JSON.stringify([sources,lookupSettings,Object.values(rosters).map(roster=>roster.members)]):"";
  useEffect(()=>{
    if(!enabled)return;
    let disposed=false,pending=false;
    const refresh=async()=>{
      if(pending)return;
      pending=true;
      try {
        const routes=new Map<string,{source:NonNullable<ReturnType<typeof boardSource>>;teams:OfficeTeamSource[]}>();
        for(const team of sources){
          const source=boardSource(lookupSettings,team.profile,team.backendId);
          if(!source)continue;
          const route=routes.get(source.key)??{source,teams:[]};
          route.teams.push(team);routes.set(source.key,route);
        }
        await Promise.all([...routes.values()].map(async ({source,teams})=>{
          let board:OfficeBoard;
          try {
            const snapshot=await fetchAgentSessions(source);
            const briefs:OfficeBoard["briefs"]={};
            const targets=new Map<string,{project:string;code:string}>();
            for(const team of teams)for(const member of rosters[team.id]?.members??[]){
              const session=matchSession(member,snapshot.sessions);
              if(session?.taskCode&&isIdentifier(session.taskCode)&&isIdentifier(session.project)&&!session.stale&&session.hostOk)
                targets.set(briefKey(session.project,session.taskCode),{project:session.project,code:session.taskCode});
            }
            await Promise.all([...targets].map(async([key,target])=>{
              if(disposed)return;
              try{const brief=await taskBrief(source,target.project,target.code);if(brief)briefs[key]=brief;}catch{/* Deleted tasks need no caption. */}
            }));
            board={snapshot,briefs,offline:false};
          }catch{board={briefs:{},offline:true};}
          if(!disposed)setBoards(previous=>({...previous,...Object.fromEntries(teams.map(team=>[team.id,board]))}));
        }));
      }finally{pending=false;}
    };
    void refresh();
    const timer=window.setInterval(()=>void refresh(),60_000);
    return()=>{disposed=true;window.clearInterval(timer);};
  },[enabled,boardKey]);
  const serviceAt=Object.values(service.snapshots).reduce((latest,team)=>Math.max(latest,team.receivedAt??0),0)||undefined;
  const officeService={state:service.status.state,at:serviceAt,tokenConfigured:service.status.token_configured};
  const buildKey=active?JSON.stringify([sources,rosters,boards,themeId,animationEnabled,officeService]):"";
  const result=useMemo(()=>{
    if(!active)return stable.current.snapshot;
    if(mailDirectoryRef)mailDirectoryRef.current=buildOfficeMailDirectory(sources,rosters);
    return buildOfficeSnapshot(sources,rosters,{servers,sessions,boards,themeId,animationEnabled,service:officeService});
  },[buildKey,active]);
  const content=active?JSON.stringify(result):stable.current.content;
  if(stable.current.content!==content)stable.current={content,snapshot:result};
  return stable.current.snapshot;
}
