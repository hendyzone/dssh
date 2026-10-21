import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { collaborationRequest, type CollaborationProfile, type CollaborationSession } from "./collaboration";
import { briefKey, fetchAgentSessions, matchSession, taskBrief } from "./agentSessions";
import { boardSource, isIdentifier, type TaskLookupSettings } from "./taskLookup";
import { loadTeamMappings, parseMember } from "./teamMembers";
import { buildOfficeMailDirectory, type OfficeMailDirectory, buildOfficeSnapshot, officeTeamSources, type OfficeBoard, type OfficeRoster, type OfficeSnapshot } from "./teamOffice";
import type { TmuxProgramSnapshot } from "./tmuxProgramStatus";
import type { ServerEntry } from "../types";

interface CachedSource { fingerprint: string; identity: string; roster?: OfficeRoster; board?: OfficeBoard; fresh: boolean; }
/** Main-only, demand-driven collection. A changed connection invalidates just its own source. */
export function useTeamOffice({ profiles, servers, sessions, programSnapshots, lookupSettings, themeId, animationEnabled, enabled = false, officeExists = false, mailDirectoryRef }: {
  profiles: Record<string, CollaborationProfile>; servers: ServerEntry[]; sessions: CollaborationSession[];
  programSnapshots: Record<string, TmuxProgramSnapshot>; lookupSettings: TaskLookupSettings;
  themeId: string; animationEnabled: boolean; enabled?: boolean; officeExists?: boolean; mailDirectoryRef?: MutableRefObject<OfficeMailDirectory>;
}) {
  const active = enabled || officeExists;
  const stable = useRef<{content:string;snapshot:OfficeSnapshot}>({content:"",snapshot:{version:1,themeId,animationEnabled,mailAvailability:"unavailable",projects:[]}});
  const activeRef = useRef(active);
  activeRef.current = active;
  const previousSourceInput = useRef("");
  const sourceInput = active ? JSON.stringify([profiles,servers,sessions]) : previousSourceInput.current;
  if(active)previousSourceInput.current=sourceInput;
  const sources = useMemo(() => active ? officeTeamSources(profiles,servers,sessions) : [], [sourceInput]);
  const key = active ? JSON.stringify([sources, lookupSettings]) : "";
  const cache = useRef(new Map<string,CachedSource>());
  const wasEnabled = useRef(false);
  const [revision, setRevision] = useState(0);
  const [mapping, setMapping] = useState(loadTeamMappings);
  useEffect(() => {
    const read = () => { if(!activeRef.current)return; const next=loadTeamMappings(); setMapping(old=>JSON.stringify(old)===JSON.stringify(next)?old:next); };
    window.addEventListener("storage",read);
    window.addEventListener("dssh-office-refresh",read);
    return () => {window.removeEventListener("storage",read);window.removeEventListener("dssh-office-refresh",read);};
  }, []);
  useEffect(() => {
    let disposed = false, pending = false;
    const resumed = enabled && !wasEnabled.current;
    wasEnabled.current = enabled;
    if(!active)return;
    const ids = new Set(sources.map(source=>source.id));
    for (const id of cache.current.keys()) if (!ids.has(id)) cache.current.delete(id);
    for (const source of sources) {
      const fingerprint = JSON.stringify([source.backendId,source.profile,lookupSettings]);
      const identity = JSON.stringify([source.id,source.profile]);
      const previous = cache.current.get(source.id);
      if (cache.current.get(source.id)?.fingerprint !== fingerprint) {
        cache.current.set(source.id,{fingerprint,identity,fresh:false,roster:source.backendId?(previous?.identity===identity?previous.roster:undefined):{availability:"offline",notice:"连接 Lead 所在服务器后可读取团队",members:[]}});
      }
    }
    setRevision(value=>value+1);
    if (!enabled || !sources.length) return;
    const nextMapping=loadTeamMappings();setMapping(old=>JSON.stringify(old)===JSON.stringify(nextMapping)?old:nextMapping);
    const refresh = async (all = true) => {
      if (pending || disposed) return;
      pending = true;
      const nextMapping=loadTeamMappings();setMapping(old=>JSON.stringify(old)===JSON.stringify(nextMapping)?old:nextMapping);
      try {
        const selected = sources.filter(source=>all || !cache.current.get(source.id)?.fresh);
        const entries = new Map(selected.map(source=>[source.id,cache.current.get(source.id)!]));
        const current = (id:string) => !disposed && cache.current.get(id)===entries.get(id);
        await Promise.all(selected.map(async source => {
          const entry=entries.get(source.id)!;
          if (!source.backendId) {entry.fresh=true;return;}
          let roster: OfficeRoster;
          try {
            const raw:unknown=JSON.parse(await collaborationRequest(source.backendId,source.profile,{operation:"members"}));
            if (!Array.isArray(raw) || raw.length>100) throw new Error("Invalid roster");
            roster={availability:"ready",notice:"",members:raw.map(member=>parseMember(member,source.project))};
          } catch { roster={availability:"error",notice:"团队读取失败，请检查 Lead 连接、会话及工作区",members:[]}; }
          if (current(source.id)) {entry.roster=roster;setRevision(value=>value+1);}
        }));
        if (disposed) return;
        const routes=new Map<string,{source:NonNullable<ReturnType<typeof boardSource>>;ids:string[]}>();
        for (const team of selected) {
          if (entries.get(team.id)?.roster?.availability!=="ready") continue;
          const source=boardSource(lookupSettings,team.profile,team.backendId);if(!source)continue;
          const group=routes.get(source.key)??{source,ids:[]};group.ids.push(team.id);routes.set(source.key,group);
        }
        await Promise.all([...routes.values()].map(async ({source,ids})=>{
          let board:OfficeBoard;
          try {
            const snapshot=await fetchAgentSessions(source);if(disposed)return;
            const briefs:OfficeBoard["briefs"]={};
            const targets=new Map<string,{project:string;code:string}>();
            for(const id of ids)for(const member of entries.get(id)?.roster?.members??[]){
              const session=matchSession(member,snapshot.sessions);
              if(session?.taskCode&&isIdentifier(session.taskCode)&&isIdentifier(session.project)&&!session.stale&&session.hostOk)
                targets.set(briefKey(session.project,session.taskCode),{project:session.project,code:session.taskCode});
            }
            await Promise.all([...targets].map(async([key,target])=>{
              if(disposed)return;
              try{const brief=await taskBrief(source,target.project,target.code);if(brief)briefs[key]=brief;}catch{/* Deleted cards need no caption. */}
            }));
            board={snapshot,briefs,offline:false};
          } catch {board={briefs:{},offline:true};}
          for(const id of ids)if(current(id))entries.get(id)!.board=board;
          if(!disposed)setRevision(value=>value+1);
        }));
        for(const id of entries.keys())if(current(id))entries.get(id)!.fresh=true;
      } finally {pending=false;}
    };
    void refresh(resumed);
    const timer=window.setInterval(()=>void refresh(),60_000);
    const requested=()=>void refresh();
    window.addEventListener("dssh-office-refresh",requested);
    return ()=>{disposed=true;window.clearInterval(timer);window.removeEventListener("dssh-office-refresh",requested);};
  }, [key,enabled,active]);
  const buildKey=active ? JSON.stringify([sources,servers,sessions,programSnapshots,mapping,themeId,animationEnabled,lookupSettings,revision]) : "";
  const result=useMemo(()=>{
    if(!active)return stable.current.snapshot;
    const rosters:Record<string,OfficeRoster>={},boards:Record<string,OfficeBoard>={};
    for(const source of sources){
      const entry=cache.current.get(source.id);
      if(!entry)continue;
      const exact = entry.fingerprint===JSON.stringify([source.backendId,source.profile,lookupSettings]);
      const sameSource = source.backendId && entry.identity===JSON.stringify([source.id,source.profile]);
      if((exact || sameSource) && entry.roster)rosters[source.id]=entry.roster;
      if(exact && entry.board)boards[source.id]=entry.board;
    }
    if(mailDirectoryRef)mailDirectoryRef.current=buildOfficeMailDirectory(sources,rosters);
    return buildOfficeSnapshot(sources,rosters,{servers,sessions,programSnapshots,mapping,boards,themeId,animationEnabled});
  },[buildKey,active]);
  const content=active ? JSON.stringify(result) : stable.current.content;
  if(stable.current.content!==content)stable.current={content,snapshot:result};
  return stable.current.snapshot;
}
