import { useEffect } from "react";
import { applyTheme, getTheme } from "../themes";
import TeamDynamics from "./TeamDynamics";
import { memberKey } from "../lib/teamMembers";
import { useTeamWindowSnapshot, sendTeamWindowAction } from "../lib/teamWindowSync";
import type { ServerEntry } from "../types";

/** Dedicated child route: no main App, SSH, taskboard access or polling hooks. */
export default function TeamWindow() {
  const { snapshot, error } = useTeamWindowSnapshot();
  useEffect(() => { if (snapshot) applyTheme(getTheme(snapshot.themeId)); }, [snapshot?.themeId]);
  if (!snapshot) return <main className="team-window">
    {error && <p role="alert">{error}</p>}
    <p role="status">正在等待主窗口的团队快照…</p>
  </main>;
  // No local SSH session here; servers come from the snapshot (credential-free), navigation.server is a dummy
  // that never matches a real member, so Lead self-detection only follows role/tmux-suffix rules.
  const servers: ServerEntry[] = snapshot.servers.map(s => ({...s, authMethod: "password" as const}));
  const dummyServer: ServerEntry = {id: "", name: "", host: "", port: 0, username: "", authMethod: "password"};
  return <main className="team-window">
    {error && <p role="alert">{error}</p>}
    <TeamDynamics sessionId={snapshot.sessionId} profile={snapshot.profile}
      navigation={{server: dummyServer, servers, onOpen: async member => { await sendTeamWindowAction({kind:"open_member", key:memberKey(member)}); }}}
      members={snapshot.members} onUpdated={async()=>{}}
      live={snapshot.live} serviceLive={snapshot.serviceLive} serviceAi={snapshot.serviceAi}
      aiEnabled={snapshot.aiEnabled} serviceIdentity={snapshot.serviceIdentity}
      officeVisible={false}
      onOpenTaskDetail={(project, code) => void sendTeamWindowAction({kind:"open_task", project, code})}
      onRefresh={() => void sendTeamWindowAction({kind:"refresh"})}
    />
  </main>;
}
