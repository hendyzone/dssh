import { useState } from "react";
import { emptyProfile, type CollaborationProfile } from "../lib/collaboration";
import { useTeamService } from "../lib/teamService";
import type { SessionInfo } from "../types";
import TeamMembers, { type TeamNavigation } from "./TeamMembers";
import { Button } from "./ui/button";
import { IconClose } from "./Icons";
import "./Collaboration.css";
import TaskLookup from "./TaskLookup";
import type { OfficeSnapshot } from "../lib/teamOffice";
import type { BoardSource, ProjectReason } from "../lib/taskLookup";

export default function TeamPanel({sessionId, profile, navigation, onClose, taskLookup, officeSnapshot, officeVisible = true, onPopOut, onRoomOpenChange}: {
  sessionId: string; pane: SessionInfo; profile?: CollaborationProfile; navigation: TeamNavigation; onClose: () => void;
  taskLookup?: { source?: BoardSource; inferred?: { project: string; reason: ProjectReason } };
  onRoomOpenChange?: (open: boolean) => void;
  officeSnapshot?: OfficeSnapshot; officeVisible?: boolean; onPopOut?: () => Promise<void>;
}) {
  const service = useTeamService();
  const [selected, setSelected] = useState("");
  const project = service.projects.includes(selected) ? selected
    : profile && service.projects.includes(profile.project) ? profile.project : service.projects[0];
  // A local terminal is only a navigation destination; it never identifies this team.
  const active = {...emptyProfile(), ...(profile?.project===project?profile:{}), enabled:true, membersEnabled:true, project:project??""};
  return <aside className="workspace-panel collaboration-panel">
    <header data-panel-drag-handle tabIndex={0}><strong>团队{project ? ` · ${project}` : ""}</strong><Button variant="ghost" size="icon-sm" aria-label="关闭团队" onClick={onClose}><IconClose/></Button></header>
    <div className="collaboration-content">
      {taskLookup && <TaskLookup source={taskLookup.source} inferred={taskLookup.inferred}/>}
      {!service.url ? <p role="status">请在协作设置中配置团队服务。</p> : !project ? <p role="status">请在团队服务设置中添加要订阅的项目。</p> : <>
        <label className="collaboration-field">团队项目<select value={project} onChange={event=>setSelected(event.target.value)}>
          {service.projects.map(name=><option key={name} value={name}>{name}</option>)}
        </select></label>
        <TeamMembers key={JSON.stringify([service.url,project])} sessionId={sessionId} profile={active} navigation={navigation} board={taskLookup?.source}
          officeSnapshot={officeSnapshot} officeVisible={officeVisible} onPopOut={onPopOut} onRoomOpenChange={onRoomOpenChange}/>
      </>}
    </div>
  </aside>;
}
