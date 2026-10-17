import { type TeamMember } from "../lib/teamMembers";
import { noteFreshness } from "../lib/agentSessions";

/** `currentTask` is what the Lead last wrote by hand, not live state: shown as 「Lead 备注」 with its age. */
const fields = [
  ["responsibilities", "职责"],
  ["currentTask", "Lead 备注"],
  ["notes", "备注"],
] as const;

export default function TeamMemberNotes({member,nowMs}:{member:TeamMember;nowMs?:number}) {
  const populated=fields.filter(([key])=>member[key]?.trim());
  if(!populated.length)return null;
  const fresh=noteFreshness(member.updatedAt,nowMs);
  const age=<small className={`team-note-age${fresh.stale?" is-stale":""}`} title={member.updatedAt?`名单更新于 ${new Date(member.updatedAt).toLocaleString()}`:"名单没有更新时间"}>{fresh.age}{fresh.stale&&" · 可能过期"}</small>;
  return <div className="team-card-extra team-member-notes">
    <div aria-label="成员摘要">{populated.map(([key,label])=>{
      const text=member[key]!.trim().split(/\r?\n/)[0].replace(/\s+/g," ");
      const chars=Array.from(text);
      // Four label characters and a colon leave fifteen for the summary.
      const brief=chars.length>15?`${chars.slice(0,14).join("")}…`:text;
      return <p className={`team-note-brief team-note-${key}`} key={key}><strong>{label}</strong><span>：{brief}</span>{key==="currentTask"&&<> {age}</>}</p>;
    })}</div>
    <details className="team-note-details"><summary>详细信息</summary>
      {populated.map(([key,label])=><p key={key}><strong>{label}：</strong>{member[key]}</p>)}
    </details>
  </div>;
}
