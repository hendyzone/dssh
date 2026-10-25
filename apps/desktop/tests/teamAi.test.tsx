import {expect,it} from "vitest";
import {memberConnection,type TeamMember} from "../src/lib/teamMembers";
import type {ServerEntry} from "../src/types";
const member:TeamMember={project:"demo",email:"w@example.invalid",role:"Worker",host:"remote",port:22,username:"dev",workdir:"/repo",tmux:{id:"$2",created:123,name:"worker"}};
const server:ServerEntry={id:"server",name:"remote",host:"remote",port:22,username:"dev",authMethod:"password"};
it("uses live panes despite duplicate connection entries and normalized host spelling",()=>{
  const first={...server,id:"one",host:" REMOTE "};const second={...server,id:"two"};
  const live=[{pane:{server:first,tmux:member.tmux},backendId:""},{pane:{server:second,tmux:member.tmux},backendId:"worker-ssh"}];
  expect(memberConnection(member,[first,second],live).backend).toBe("worker-ssh");
  expect(memberConnection(member,[first],live).backend).toBe("worker-ssh");
  expect(memberConnection(member,[first],[{pane:{server:{...second,username:"other"}},backendId:"wrong-user"}]).backend).toBeUndefined();
});

it("finds the live worker on another IP instead of a stale mapped address",()=>{
  const old={...server,host:"192.0.2.7"};
  const current={...server,id:"vpn-route",host:"192.0.2.8",port:2222};
  const worker={...member,host:old.host};
  const pane={server:current,tmux:worker.tmux,tmuxWorkdir:worker.workdir};
  const mappings={[JSON.stringify([worker.project,worker.email,worker.host,worker.port,worker.username])]:old.id};
  expect(memberConnection(worker,[old,current],[{pane,backendId:"vpn-ssh"}],mappings)).toEqual({server:current,backend:"vpn-ssh"});
  expect(memberConnection(worker,[old,current],[{pane:{...pane,tmux:{...pane.tmux,created:999}},backendId:"reused"}],mappings).backend).toBeUndefined();
  expect(memberConnection(worker,[old,current],[{pane:{...pane,tmuxWorkdir:"/another"},backendId:"wrong-root"}],mappings).backend).toBeUndefined();
  expect(memberConnection(worker,[old,current],[{pane,backendId:"vpn-ssh"},{pane:{...pane,server:{...current,id:"unrelated",host:"different-host"}},backendId:"ambiguous"}],mappings).backend).toBeUndefined();
});
