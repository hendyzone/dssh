import type { CSSProperties } from "react";
import type { TeamAvatarStatus } from "../lib/teamAvatar";
import "./TeamMemberAvatar.css";

/** Presentation anchor owned by the avatar, above its full status-symbol area. */
export function readTeamAvatarMailAnchor(station:Element) {
  const anchors=station.querySelectorAll('[data-avatar-mail-anchor]');
  if(anchors.length!==1)return null;
  const rect=anchors[0].getBoundingClientRect();
  return rect.width && rect.height ? {x:rect.left+rect.width/2,y:rect.top} : null;
}

/** Original integer-grid artwork. Palette is a visual hint, not an identity. */
export default function TeamMemberAvatar({ memberId, status, motionEnabled = true, paused = false, scale = 1 }: {
  memberId: string;
  status: TeamAvatarStatus;
  motionEnabled?: boolean;
  paused?: boolean;
  scale?: 1 | 2 | 3;
}) {
  let hash = 0;
  for (const character of memberId) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
  const state = status.state;
  const shirt = ["#5198b7", "#9b82bf", "#c68c48", "#5b9e83"][hash % 4];
  return <span className="team-member-avatar" data-state={state} data-motion={motionEnabled ? "on" : "off"}
    data-paused={String(paused)} style={{"--avatar-shirt": shirt, width:28 * scale, height:32 * scale, flexBasis:28 * scale} as CSSProperties}>
    <svg width={28 * scale} height={32 * scale} viewBox="0 0 28 32" shapeRendering="crispEdges" role="img" aria-label={status.label}>
      <title>{status.label}</title>
      <rect data-avatar-mail-anchor="true" x="13" y="-3" width="2" height="1" fill="none" pointerEvents="none"/>
      <path className="team-avatar-ground" d="M3 29h22v1H3z"/>
      <g className={state === "working" ? undefined : "team-avatar-motion"}>
        <path className="team-avatar-outline" d="M9 10h10v2h2v8h-2v3h2v5h-5v-4h-4v4H7v-5h2v-3H7v-8h2z"/>
        <path className="team-avatar-hair" d="M9 10h10v2h2v3h-2v-2H9v2H7v-3h2z"/>
        <path className="team-avatar-face" d="M9 14h10v6H9z"/>
        <path className="team-avatar-shirt" d="M9 20h10v4H9z"/>
        {state === "idle" ? <path className="team-avatar-ink" d="M10 16h3v1h-3zm5 0h3v1h-3z"/>
          : <path className="team-avatar-ink" d="M11 15h1v2h-1zm5 0h1v2h-1z"/>}
        {state === "working" ? <><path className="team-avatar-face team-avatar-motion" d="M5 22h4v2H5zm14 0h4v2h-4z"/><path className="team-avatar-outline" d="M3 25h22v3H3z"/><path className="team-avatar-keyboard" d="M5 25h18v1H5z"/></>
          : state === "done" ? <path className="team-avatar-face" d="M4 11h3v12H4zm17 0h3v12h-3z"/>
          : state === "blocked" ? <path className="team-avatar-face" d="M5 19h2v4H5zm16 2h2v3h-2z"/>
          : state === "error" ? <path className="team-avatar-face" d="M5 14h2v8H5zm16 0h2v8h-2z"/>
          : <path className="team-avatar-face" d="M7 21h2v4H7zm12 0h2v4h-2z"/>}
      </g>
      {state === "idle" && <path className="team-avatar-symbol team-avatar-motion team-avatar-sleep" d="M16 7h4v1h-1v1h-1v1h2v1h-4v-1h1V9h1V8h-2zm5-6h6v1h-2v1h-2v1h4v1h-6V4h2V3h2V2h-4z"/>}
      {state === "done" && <path className="team-avatar-symbol" d="M10 5h2v2h2V5h2V3h2v3h-2v2h-2v2h-2V8h-2z"/>}
      {state === "blocked" && <path className="team-avatar-symbol" d="M11 1h6v1h2v3h-2v1h-2v1h-2V5h2V4h2V3h-4v1h-2zm2 7h2v1h-2z"/>}
      {state === "error" && <path className="team-avatar-symbol" d="M13 1h2v6h-2zm0 8h2v2h-2z"/>}
      {state === "unknown" && <path className="team-avatar-symbol" d="M9 5h2v2H9zm4 0h2v2h-2zm4 0h2v2h-2z"/>}
    </svg>
  </span>;
}
