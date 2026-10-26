import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TeamPanel from '../src/components/TeamPanel';
import { paneTeamProject } from '../src/lib/tmuxGroups';
import { clearBoardCache, defaultLookupSettings, inferProject, saveLookupSettings, teamLookupScope } from '../src/lib/taskLookup';
import type { ServerEntry, SessionInfo } from '../src/types';

const service = vi.hoisted(() => ({ current: {} as any }));
vi.mock('../src/lib/teamService', () => ({ useTeamService: () => service.current }));
vi.mock('../src/components/TeamMembers', () => ({ default: () => null }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const server: ServerEntry = { id: 'test', name: 'Test', host: 'host-a', port: 22, username: 'dev', authMethod: 'password' };
const paneA: SessionInfo = { id: 'pane-a', server, tmux: { id: '$a', created: 1, name: 'dcollab-lead' } };
const paneB: SessionInfo = { id: 'pane-b', server, tmux: { id: '$b', created: 2, name: 'dnotes-lead' } };
const member = (project: string, id: string, created: number, name: string) => ({
  project, email: `${name}@example.invalid`, role: 'worker', host: 'host-a', port: 22, username: 'dev',
  workdir: '/srv/example', tmux: { id, created, name },
});
const snapshots = {
  dcollab: { members: [member('dcollab', '$c', 3, 'worker-dcollab-cw3-dsh')] },
  dnotes: { members: [member('dnotes', '$b', 2, 'dnotes-lead'), member('dnotes', '$d', 4, 'worker-dnotes-cw3-pi')] },
  gamma: { members: [] },
};
function panel(pane: SessionInfo, onLookupScopeChange = vi.fn()) {
  return <TeamPanel sessionId='' pane={pane} navigation={{ server, servers: [server], onOpen: vi.fn() }} onClose={vi.fn()} onLookupScopeChange={onLookupScopeChange}/>;
}
beforeEach(() => {
  localStorage.clear();
  clearBoardCache();
  saveLookupSettings(defaultLookupSettings());
  service.current = { url: 'https://team.example.invalid/api/v1', projects: ['dcollab', 'dnotes', 'gamma'],
    status: { state: 'online', token_configured: true }, snapshots };
});
afterEach(cleanup);

it('derives dcollab / dnotes from the Lead session in each tab', () => {
  expect(paneTeamProject(paneA, undefined, undefined, service.current)).toBe('dcollab');
  expect(paneTeamProject(paneB, undefined, undefined, service.current)).toBe('dnotes');
  expect(paneTeamProject({ tmux: { id: '$x', created: 9, name: 'lead-gamma' } }, undefined, undefined, service.current)).toBe('gamma');
});

it('derives a worker session project from the team-service snapshot without another fetch', () => {
  const worker = { server, tmux: { id: '$d', created: 4, name: 'worker-dnotes-cw3-pi' } };
  expect(paneTeamProject(worker, undefined, undefined, service.current)).toBe('dnotes');
  // id + created must both match; a reused id is a different session.
  expect(paneTeamProject({ server, tmux: { id: '$d', created: 5, name: 'x' } }, undefined, undefined, service.current)).toBe('dcollab');
});

it('keeps manual selections per pane and ignores selections outside the subscribed projects', () => {
  const view = render(panel(paneA));
  expect(screen.getByText('团队 · dcollab')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('团队项目'), { target: { value: 'gamma' } });
  expect(screen.getByText('团队 · gamma')).toBeTruthy();
  view.rerender(panel(paneB));                       // 同一组件换标签页
  expect(screen.getByText('团队 · dnotes')).toBeTruthy();
  view.rerender(panel(paneA));
  expect(screen.getByText('团队 · gamma')).toBeTruthy();
  expect(paneTeamProject(paneB, 'not-subscribed', undefined, service.current)).toBe('dnotes');
});

it('does not expose pane A\'s lock when pane A and pane B infer different projects', () => {
  const settings = defaultLookupSettings();
  const scopeA = teamLookupScope(service.current.url, 'dcollab')!;
  saveLookupSettings({ ...settings, teamLocks: { [scopeA.key]: 'gamma' } });
  const scopeB = teamLookupScope(service.current.url, 'dnotes')!;
  const result = inferProject({ ...settings, teamLocks: { [scopeA.key]: 'gamma' } }, paneB, service.current, scopeB);
  expect(result).toEqual({ project: 'dnotes', reason: 'team' });
  expect(result?.reason).not.toBe('locked');
  // pane B 自己的 scope 没锁，不应出现 locked
  expect(inferProject({ ...settings, teamLocks: { [scopeA.key]: 'gamma' } }, paneB, service.current, scopeB)?.reason).not.toBe('locked');
});

it.each(["host.example.invalid","alias.example.invalid"])("selects a renamed Lead's roster project in the real panel: %s",host=>{
 const lead={id:"lead",server:{...server,host:"host.example.invalid"},tmux:{id:"$10",created:1234,name:"smart-table-lead"}};
 service.current={...service.current,projects:["alpha","new_smart_table"],snapshots:{alpha:{members:[]},new_smart_table:{members:[{...member("new_smart_table","$10",1234,"smart-table-lead"),host}]}}};
 render(panel(lead));
 expect(screen.getByText("团队 · new_smart_table")).toBeTruthy();
 expect(screen.getByLabelText("团队项目")).toHaveProperty("value","new_smart_table");
});
