import { useEffect, useState } from "react";
import { collaborationRequest, type CollaborationProfile, type CollaborationSession } from "./collaboration";
import { briefKey, fetchAgentSessions, matchSession, taskBrief } from "./agentSessions";
import { boardSource, isIdentifier, type TaskLookupSettings } from "./taskLookup";
import { loadTeamMappings, parseMember } from "./teamMembers";
import { buildOfficeSnapshot, officeTeamSources, type OfficeBoard, type OfficeRoster } from "./teamOffice";
import type { TmuxProgramSnapshot } from "./tmuxProgramStatus";
import type { ServerEntry } from "../types";

/** The only office collector. This hook is mounted in App, never in the popup. */
export function useTeamOffice({ profiles, servers, sessions, programSnapshots, lookupSettings, themeId, animationEnabled }: {
  profiles: Record<string, CollaborationProfile>; servers: ServerEntry[]; sessions: CollaborationSession[];
  programSnapshots: Record<string, TmuxProgramSnapshot>; lookupSettings: TaskLookupSettings;
  themeId: string; animationEnabled: boolean;
}) {
  const sources = officeTeamSources(profiles, servers, sessions);
  const key = JSON.stringify([sources, lookupSettings]);
  const [data, setData] = useState<{key: string; rosters: Record<string, OfficeRoster>; boards: Record<string, OfficeBoard>}>();
  useEffect(() => {
    let disposed = false, pending = false;
    if (!sources.length) return;
    const refresh = async () => {
      if (pending || disposed) return;
      pending = true;
      try {
        const rosters: Record<string, OfficeRoster> = {};
        await Promise.all(sources.map(async source => {
          if (!source.backendId) { rosters[source.id] = {availability:"offline",notice:"连接 Lead 所在服务器后可读取团队",members:[]}; return; }
          try {
            const raw: unknown = JSON.parse(await collaborationRequest(source.backendId, source.profile, {operation:"members"}));
            if (!Array.isArray(raw) || raw.length > 100) throw new Error("Invalid roster");
            rosters[source.id] = {availability:"ready",notice:"",members:raw.map(member => parseMember(member, source.project))};
          } catch {
            rosters[source.id] = {availability:"error",notice:"团队读取失败，请检查 Lead 连接、会话及工作区",members:[]};
          }
        }));
        if (disposed) return;
        // Render the verified rosters immediately; slow board lookups only enrich captions.
        setData({key,rosters,boards:{}});
        const boards: Record<string, OfficeBoard> = {};
        const routes = new Map<string, {source: NonNullable<ReturnType<typeof boardSource>>; ids: string[]}>();
        for (const team of sources) {
          if (rosters[team.id].availability !== "ready") continue;
          const source = boardSource(lookupSettings, team.profile, team.backendId);
          if (!source) continue;
          const group = routes.get(source.key) ?? {source, ids:[]};
          group.ids.push(team.id); routes.set(source.key, group);
        }
        await Promise.all([...routes.values()].map(async ({source,ids}) => {
          let board: OfficeBoard;
          try {
            const snapshot = await fetchAgentSessions(source);
            const briefs: OfficeBoard["briefs"] = {};
            const targets = new Map<string, {project:string;code:string}>();
            for (const id of ids) for (const member of rosters[id].members) {
              const session = matchSession(member, snapshot.sessions);
              if (session?.taskCode && isIdentifier(session.taskCode) && isIdentifier(session.project) && !session.stale && session.hostOk)
                targets.set(briefKey(session.project,session.taskCode), {project:session.project,code:session.taskCode});
            }
            await Promise.all([...targets].map(async ([key,target]) => {
              try { const brief = await taskBrief(source,target.project,target.code); if (brief) briefs[key] = brief; } catch { /* A card may disappear while its collector snapshot is still current. */ }
            }));
            board = {snapshot,briefs,offline:false};
          } catch { board = {briefs:{},offline:true}; }
          for (const id of ids) boards[id] = board;
        }));
        if (!disposed) setData({key,rosters,boards});
      } finally { pending = false; }
    };
    void refresh();
    // One slow main-window refresh for every registered team, never per member.
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("dssh-office-refresh", refresh);
    return () => { disposed = true; window.clearInterval(timer); window.removeEventListener("dssh-office-refresh", refresh); };
  }, [key]);
  const current = data?.key === key ? data : undefined;
  return buildOfficeSnapshot(sources, current?.rosters ?? {}, {
    servers,sessions,programSnapshots,mapping:loadTeamMappings(),boards:current?.boards,
    themeId,animationEnabled,
  });
}
