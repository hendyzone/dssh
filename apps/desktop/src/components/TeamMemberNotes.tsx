import { type TeamMember } from "../lib/teamMembers";

const fields = [
  ["responsibilities", "职责"],
  ["currentTask", "当前"],
  ["notes", "备注"],
] as const;

export default function TeamMemberNotes({member}:{member:TeamMember}) {
  const populated=fields.filter(([key])=>member[key]?.trim());
  if(!populated.length)return null;
  return <div className="team-card-extra team-member-notes">
    <div aria-label="成员摘要">{populated.map(([key,label])=>{
      const text=member[key]!.trim().split(/\r?\n/)[0].replace(/\s+/g," ");
      const chars=Array.from(text);
      // Four label characters and a colon leave fifteen for the summary.
      const brief=chars.length>15?`${chars.slice(0,14).join("")}…`:text;
      return <p className={`team-note-brief team-note-${key}`} key={key}><strong>{label}</strong><span>：{brief}</span></p>;
    })}</div>
    <details className="team-note-details"><summary>详细信息</summary>
      {populated.map(([key,label])=><p key={key}><strong>{label}：</strong>{member[key]}</p>)}
    </details>
  </div>;
}
