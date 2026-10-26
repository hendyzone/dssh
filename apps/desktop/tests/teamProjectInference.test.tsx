import {beforeEach,expect,it} from 'vitest';
import {defaultLookupSettings,inferProject,loadLookupSettings,saveLookupSettings,teamLookupScope,TASK_LOOKUP_KEY} from '../src/lib/taskLookup';
import type {TeamServiceState} from '../src/lib/teamService';
import type {SessionInfo} from '../src/types';
const pane:SessionInfo={id:'pane',server:{id:'server',name:'Server',host:'host-a',port:22,username:'dev',authMethod:'password'},tmux:{id:'$2',created:20,name:'worker'}};
const member={project:'alpha',email:'worker@example.invalid',role:'Worker',host:'host-a',port:22,username:'dev',workdir:'/srv/example',tmux:{id:'$2',created:20,name:'worker'}};
function service():TeamServiceState{return {url:'https://team.example.invalid/api/v1',projects:['alpha','beta'],status:{state:'online',token_configured:true},snapshots:{alpha:{project:'alpha',seq:1,lseq:1,members:[member],ai:{},live:{},machines:{},receivedAt:1,offline:false,status:'online',identity:'alpha'}}};}
beforeEach(()=>localStorage.clear());
it('identifies the unique subscribed exact tmux incarnation and endpoint',()=>{
 expect(inferProject(defaultLookupSettings(),pane,service())).toEqual({project:'alpha',reason:'team'});
});
it.each([{tmux:{...pane.tmux!,id:'$9'}},{tmux:{...pane.tmux!,created:99}},{server:{...pane.server,host:'host-b'}},{server:{...pane.server,port:2222}},{server:{...pane.server,username:'other'}}])('does not infer from mismatched terminal identity %j',patch=>{
 expect(inferProject(defaultLookupSettings(),{...pane,...patch},service())).toBeUndefined();
});
it('rejects multi-project ambiguity and unsubscribed or offline rosters',()=>{
 const state=service();state.snapshots.beta={...state.snapshots.alpha,project:'beta',members:[{...member,project:'beta'}]};
 expect(inferProject(defaultLookupSettings(),pane,state)).toBeUndefined();
 state.projects=[];expect(inferProject(defaultLookupSettings(),pane,state)).toBeUndefined();
 state.projects=['alpha'];state.status.state='offline';expect(inferProject(defaultLookupSettings(),pane,state)).toBeUndefined();
 state.status.state='online';state.snapshots.alpha.offline=true;expect(inferProject(defaultLookupSettings(),pane,state)).toBeUndefined();
});
it('prioritizes the explicitly active team lock but never the old global lock or overrides',()=>{
 const state=service();const scope=teamLookupScope(state.url,'alpha')!;
 const settings={...defaultLookupSettings(),lockedProject:'old-global',teamLocks:{[scope.key]:'shared'}};
 expect(inferProject(settings,pane,state,scope)).toEqual({project:'shared',reason:'locked'});
 expect(inferProject(settings,pane,state)).toEqual({project:'alpha',reason:'team'});
 expect(inferProject(settings,{...pane,tmux:undefined},state)).toBeUndefined();
});
it('drops retired manual overrides when loading and saving old preferences',()=>{
 localStorage.setItem(TASK_LOOKUP_KEY,JSON.stringify({...defaultLookupSettings(),overrides:{'server:server':'legacy'}}));
 expect(loadLookupSettings()).not.toHaveProperty('overrides');expect(JSON.parse(localStorage.getItem(TASK_LOOKUP_KEY)!)).not.toHaveProperty('overrides');saveLookupSettings({terminalLinks:false});
 expect(JSON.parse(localStorage.getItem(TASK_LOOKUP_KEY)!)).not.toHaveProperty('overrides');
});

it('ignores a stale active scope from another service before panel effects run',()=>{
 const state=service();const scope=teamLookupScope('https://previous.example.invalid/api/v1','alpha')!;
 expect(inferProject({...defaultLookupSettings(),teamLocks:{[scope.key]:'stale'}},pane,state,scope)).toEqual({project:'alpha',reason:'team'});
});
