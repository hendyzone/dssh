import type { ReactNode } from "react";
import type { CollaborationProfile } from "../lib/collaboration";
import { useTeamService } from "../lib/teamService";
import { matchingServers, memberKey } from "../lib/teamMembers";
import TeamMemberNotes from "./TeamMemberNotes";
import TeamServiceBanner from "./TeamServiceBanner";
import type { SessionInfo } from "../types";
import type { TeamNavigation } from "./TeamMembers";

/** Current-terminal membership is a view of the subscribed service roster, never a remote read. */
export default function TeamMembership({pane}: {
  sessionId:string; pane:SessionInfo; navigation:TeamNavigation; children:ReactNode; onPromoted:(profile:CollaborationProfile)=>void;
}) {
  const service=useTeamService();
  const teams=service.projects.flatMap(project=>{
    const snapshot=service.snapshots[project];
    return (snapshot?.members??[]).filter(member=>matchingServers(member,[pane.server]).length>0
      && member.tmux.id===pane.tmux?.id && member.tmux.created===pane.tmux?.created)
      .map(member=>({member,snapshot}));
  });
  return <section className="team-members" aria-label="当前窗口的团队">
    {!!service.url&&!teams.length&&<TeamServiceBanner status={service.status}/>}
    {!service.url?<p role="status">请在协作设置中配置团队服务。</p>:!teams.length?<p>当前终端不在已订阅项目的名单中。</p>:teams.map(({member,snapshot})=><article className="team-card" key={JSON.stringify([snapshot.identity,memberKey(member)])}>
      <strong>{member.project} · {member.role}</strong>
      <TeamServiceBanner project={snapshot} status={service.status}/>
      <TeamMemberNotes member={member}/>
      <p>编辑将在后续版本开放</p>
    </article>)}
  </section>;
}
