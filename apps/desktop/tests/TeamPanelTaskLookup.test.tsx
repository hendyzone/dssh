import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import TeamPanel from '../src/components/TeamPanel';
import CollaborationPanel from '../src/components/CollaborationPanel';
import {emptyProfile} from '../src/lib/collaboration';
import {boardSource,clearBoardCache,defaultLookupSettings,loadLookupSettings,saveLookupSettings,teamLookupScope} from '../src/lib/taskLookup';
import type {ServerEntry,SessionInfo} from '../src/types';
const service=vi.hoisted(()=>({current:{} as any}));
vi.mock('../src/lib/teamService',()=>({useTeamService:()=>service.current}));
vi.mock('../src/components/TeamMembers',()=>({default:()=>null}));
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
const server:ServerEntry={id:'test',name:'Test',host:'host-a',port:22,username:'dev',authMethod:'password'};
const pane:SessionInfo={id:'pane',server};
const source=boardSource({...defaultLookupSettings(),boardUrl:'https://board.example.invalid'})!;
function panel(){return <TeamPanel sessionId='' pane={pane} navigation={{server,servers:[server],onOpen:vi.fn()}} onClose={vi.fn()} onOpenTaskDetail={vi.fn()} taskLookup={{source,inferred:{project:'global-project',reason:'locked'}}}/>;}
beforeEach(()=>{localStorage.clear();clearBoardCache();saveLookupSettings({lockedProject:'global-project'});service.current={url:'https://team.example.invalid/api/v1',projects:['alpha','beta'],status:{state:'online',token_configured:true},snapshots:{}};vi.mocked(invoke).mockResolvedValue({status:200,body:JSON.stringify({projects:[{slug:'alpha',name:'Alpha'},{slug:'beta',name:'Beta'},{slug:'shared',name:'Shared'}]})});});
afterEach(cleanup);
it('changes the task lock with the actual team selector while retaining each team choice',async()=>{
 render(panel());await screen.findByRole('button',{name:'解锁'});expect(screen.getByText('Alpha')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'解锁'}));fireEvent.change(screen.getByLabelText('查询项目'),{target:{value:'shared'}});fireEvent.click(screen.getByRole('button',{name:'锁定'}));
 fireEvent.change(screen.getByLabelText('团队项目'),{target:{value:'beta'}});await screen.findByText('Beta');
 expect(loadLookupSettings().teamLocks?.[teamLookupScope(service.current.url,'beta')!.key]).toBe('beta');
 fireEvent.change(screen.getByLabelText('团队项目'),{target:{value:'alpha'}});await screen.findByText('Shared');
 expect(loadLookupSettings().lockedProject).toBe('global-project');
});
it('never exposes the global lock when the team identity is not configured',()=>{
 service.current={...service.current,url:'',projects:[]};render(panel());expect(screen.getByText('请在协作设置中配置团队服务。')).toBeTruthy();
 expect(screen.queryByRole('region',{name:'任务查询'})).toBeNull();expect(screen.queryByText('global-project')).toBeNull();
});
it('remounts lookup for a different service even with the same selected project',async()=>{
 const view=render(panel());await screen.findByRole('button',{name:'解锁'});fireEvent.click(screen.getByRole('button',{name:'解锁'}));
 service.current={...service.current,url:'https://other.example.invalid/api/v1'};view.rerender(panel());
 await waitFor(()=>expect(loadLookupSettings().teamLocks?.[teamLookupScope(service.current.url,'alpha')!.key]).toBe('alpha'));
 expect(screen.getByRole('button',{name:'解锁'})).toBeTruthy();
});

it('scopes legacy Lead lookup and keeps its unlocked state after the tmux process restarts',async()=>{
 const profile={...emptyProfile(),project:'alpha',workdir:'/srv/example',tmuxName:'lead',tmuxId:'$1',tmuxCreated:1};
 const props={sessionId:'backend',profile,onClose:vi.fn(),onOpenTaskDetail:vi.fn(),teamNavigation:{server,servers:[server],onOpen:vi.fn()},taskLookup:{source,inferred:{project:'global-project',reason:'locked' as const}}};
 const view=render(<CollaborationPanel {...props}/>);
 const details=screen.getByText('查任务（编号 → 状态卡片）').closest('details')!;details.open=true;
 await screen.findByRole('button',{name:'解锁'});expect(screen.getByText('Alpha')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'解锁'}));
 view.rerender(<CollaborationPanel {...props} sessionId='new-backend' profile={{...profile,tmuxId:'$9',tmuxCreated:9}}/>);
 expect(screen.queryByRole('button',{name:'解锁'})).toBeNull();expect(loadLookupSettings().teamLocks?.[teamLookupScope('',profile.project,server,profile)!.key]).toBe('');
});
it('omits legacy lookup without a valid binding instead of exposing the global lock',()=>{
 render(<CollaborationPanel sessionId='' profile={emptyProfile()} onClose={vi.fn()} taskLookup={{source}}/>);
 expect(screen.queryByRole('region',{name:'任务查询',hidden:true})).toBeNull();expect(screen.queryByText('global-project')).toBeNull();
});
