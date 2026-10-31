import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import TaskLookup from '../src/components/TaskLookup';
import {boardSource,clearBoardCache,defaultLookupSettings,loadLookupSettings,saveLookupSettings,teamLookupScope,saveTeamLock,TASK_LOOKUP_KEY,validTeamLockKey} from '../src/lib/taskLookup';
import {collectSyncUi,restoreSyncUi} from '../src/lib/syncUi';
import {emptyProfile} from '../src/lib/collaboration';
import type {ServerEntry} from '../src/types';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
const source=boardSource({...defaultLookupSettings(),boardUrl:'https://board.example.invalid'})!;
const noop=()=>{};
const scope=(project='alpha',url='https://team.example.invalid/api/v1')=>teamLookupScope(url,project)!;
const reply={status:200,body:JSON.stringify({projects:[{slug:'alpha',name:'Alpha'},{slug:'beta',name:'Beta'},{slug:'shared',name:'Shared'}]})};
beforeEach(()=>{localStorage.clear();clearBoardCache();vi.mocked(invoke).mockReset().mockResolvedValue(reply);});
afterEach(cleanup);
it('defaults to the matching board project without inheriting the old global lock',async()=>{
 saveLookupSettings({lockedProject:'shared'});render(<TaskLookup source={source} teamScope={scope()} inferred={{project:'shared',reason:'locked'}} onOpenTaskDetail={noop}/>);
 await screen.findByRole('button',{name:'解锁'});expect(screen.getByText('Alpha')).toBeTruthy();
 expect(loadLookupSettings().teamLocks?.[scope().key]).toBe('alpha');expect(loadLookupSettings().lockedProject).toBe('shared');
});
it('keeps two teams independent and preserves explicit unlock across switches and remounts',async()=>{
 const view=render(<TaskLookup source={source} teamScope={scope()} onOpenTaskDetail={noop}/>);await screen.findByRole('button',{name:'解锁'});
 fireEvent.click(screen.getByRole('button',{name:'解锁'}));
 fireEvent.change(screen.getByLabelText('查询项目'),{target:{value:'shared'}});fireEvent.click(screen.getByRole('button',{name:'锁定'}));
 view.rerender(<TaskLookup source={source} teamScope={scope('beta')} onOpenTaskDetail={noop}/>);await waitFor(()=>expect(loadLookupSettings().teamLocks?.[scope('beta').key]).toBe('beta'));
 fireEvent.click(screen.getByRole('button',{name:'解锁'}));expect(loadLookupSettings().teamLocks?.[scope('beta').key]).toBe('');
 view.rerender(<TaskLookup source={source} teamScope={scope()} onOpenTaskDetail={noop}/>);expect(await screen.findByText('Shared')).toBeTruthy();
 view.rerender(<TaskLookup source={source} teamScope={scope('beta')} onOpenTaskDetail={noop}/>);await screen.findByLabelText('查询项目');expect(screen.queryByRole('button',{name:'解锁'})).toBeNull();
 view.unmount();render(<TaskLookup source={source} teamScope={scope('beta')} onOpenTaskDetail={noop}/>);await screen.findByLabelText('查询项目');expect(loadLookupSettings().teamLocks?.[scope('beta').key]).toBe('');
});
it('isolates the same project on two services',async()=>{
 saveTeamLock(scope(),'shared');const other=scope('alpha','https://other.example.invalid/api/v1');
 render(<TaskLookup source={source} teamScope={other} onOpenTaskDetail={noop}/>);await waitFor(()=>expect(loadLookupSettings().teamLocks?.[other.key]).toBe('alpha'));
 expect(loadLookupSettings().teamLocks?.[scope().key]).toBe('shared');
});
it('keeps a missing same-slug project unlocked but lets the user select another visible project',async()=>{
 render(<TaskLookup source={source} teamScope={scope('absent')} onOpenTaskDetail={noop}/>);
 await waitFor(()=>expect(loadLookupSettings().teamLocks?.[scope('absent').key]).toBe(''));
 expect(screen.queryByRole('button',{name:'解锁'})).toBeNull();fireEvent.change(screen.getByLabelText('查询项目'),{target:{value:'shared'}});fireEvent.click(screen.getByRole('button',{name:'锁定'}));
 expect(loadLookupSettings().teamLocks?.[scope('absent').key]).toBe('shared');
});
it('does not initialize a lock when project discovery fails',async()=>{
 vi.mocked(invoke).mockRejectedValue(new Error('Offline'));render(<TaskLookup source={source} teamScope={scope()} onOpenTaskDetail={noop}/>);await screen.findByRole('alert');
 expect(loadLookupSettings().teamLocks).toBeUndefined();
});
it('clears input on scope switches and ignores discovery for an unmounted scope',async()=>{
 let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<TaskLookup source={source} teamScope={scope()} onOpenTaskDetail={noop}/>);fireEvent.change(screen.getByLabelText('任务编号'),{target:{value:'T1'}});
 view.rerender(<TaskLookup source={source} teamScope={scope('beta')} onOpenTaskDetail={noop}/>);expect((screen.getByLabelText('任务编号') as HTMLInputElement).value).toBe('');
 await act(async()=>finish(reply));expect(loadLookupSettings().teamLocks?.[scope().key]).toBeUndefined();expect(loadLookupSettings().teamLocks?.[scope('beta').key]).toBe('beta');
});
it('retains old global lock and uses it outside a team',async()=>{
 localStorage.setItem(TASK_LOOKUP_KEY,JSON.stringify({...defaultLookupSettings(),lockedProject:'shared'}));
 render(<TaskLookup source={source} onOpenTaskDetail={noop}/>);expect(loadLookupSettings().teamLocks).toBeUndefined();await screen.findByText('Shared');
 fireEvent.click(screen.getByRole('button',{name:'解锁'}));expect(loadLookupSettings().lockedProject).toBe('');expect(loadLookupSettings().teamLocks).toBeUndefined();
});
it('uses stable legacy Lead binding identity across backend, UUID and tmux incarnation changes',()=>{
 const server:ServerEntry={id:'one',name:'Server',host:'HOST-A',port:22,username:'dev',authMethod:'password'};
 const profile={...emptyProfile(),project:'alpha',workdir:'/srv/example',tmuxName:'lead',tmuxId:'$1',tmuxCreated:100};
 const first=teamLookupScope('',profile.project,server,profile)!;
 const restarted=teamLookupScope('',profile.project,{...server,id:'new-device'},{...profile,tmuxId:'$9',tmuxCreated:900})!;
 expect(first.key).toBe(restarted.key);saveTeamLock(first,'shared');expect(loadLookupSettings().teamLocks?.[restarted.key]).toBe('shared');
 expect(teamLookupScope('',profile.project,{...server,host:'host-b'},profile)?.key).not.toBe(first.key);
 expect(teamLookupScope('',profile.project,server,{...profile,tmuxName:'another-lead'})?.key).not.toBe(first.key);
});
it('round-trips scoped locks through UI sync including explicit unlock without changing global migration',()=>{
 saveLookupSettings({lockedProject:'shared'});saveTeamLock(scope(),'alpha');saveTeamLock(scope('beta'),'');const before=loadLookupSettings();
 const backup=collectSyncUi();localStorage.clear();restoreSyncUi(backup);expect(loadLookupSettings()).toEqual(before);
});
it('rejects malformed or oversized scope maps before saving',()=>{
 expect(validTeamLockKey(JSON.stringify(['service','https://user:secret@example.invalid/api/v1','alpha']))).toBe(false);
 expect(validTeamLockKey(JSON.stringify(['legacy',JSON.stringify(['host-a',22,'dev','/srv/\u0085path','lead']),'alpha']))).toBe(false);
 expect(()=>saveLookupSettings({teamLocks:{bad:'alpha'}})).toThrow();
 expect(()=>saveLookupSettings({teamLocks:Object.fromEntries(Array.from({length:257},(_,i)=>[scope('p'+i).key,'']))})).toThrow();
});
