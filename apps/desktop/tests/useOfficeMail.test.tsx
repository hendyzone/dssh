import {act,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useOfficeMail} from '../src/lib/useOfficeMail';
import {collaborationRequest,collaborationKey,emptyProfile} from '../src/lib/collaboration';
vi.mock('../src/lib/collaboration',async original=>({...await original<any>(),collaborationRequest:vi.fn()}));
const server={id:'remote',name:'Remote',host:'example.test',port:22,username:'dev',authMethod:'password' as const};
const profile={...emptyProfile(),enabled:true,mailEnabled:true,project:'alpha',workdir:'/repo',tmuxId:'$1',tmuxCreated:100,tmuxName:'lead'};
const options=(count=1)=>({enabled:true,profiles:Object.fromEntries(Array.from({length:count},(_,i)=>{const p={...profile,tmuxId:`$${i+1}`};return [collaborationKey(server.id,p),p]})),servers:[server],sessions:[{pane:{id:'pane',server,tmux:{id:'$1',created:100,name:'lead'}},backendId:'ssh'}],directory:{current:new Map()}});
const page=(uid=0,complete=true,next=uid)=>JSON.stringify({schema:'amail.inbox.headers.v1',namespace:{server:'imap',port:993,account:'test',mailbox:'INBOX'},uidvalidity:1,max_uid:uid,highwater_uid:uid,next_after_uid:next,complete,has_more:!complete,errors:[],messages:uid&&complete?[{uid,from:'sender@x',to:['recipient@x'],kind:'ack'}]:[]});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);vi.mocked(collaborationRequest).mockReset().mockResolvedValue(page());});
afterEach(()=>{vi.useRealTimers()});
const flush=async()=>act(async()=>{await Promise.resolve();await Promise.resolve()});
it('mounts inactive without any remote calls, polls every 30 seconds and baselines first pull',async()=>{
 const opts=options();const h=renderHook(({enabled})=>useOfficeMail({...opts,enabled}),{initialProps:{enabled:false}});await flush();expect(collaborationRequest).not.toHaveBeenCalled();
 h.rerender({enabled:true});await flush();expect(collaborationRequest).toHaveBeenCalledTimes(1);expect(h.result.current.sequence).toBe(0);
 vi.mocked(collaborationRequest).mockResolvedValue(page(1));await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(collaborationRequest).toHaveBeenCalledTimes(2);expect(h.result.current.events).toHaveLength(1);h.unmount();
});
it('keeps at most two physical calls across hide/resume and ignores late responses',async()=>{
 const resolvers:Array<(s:string)=>void>=[];vi.mocked(collaborationRequest).mockImplementation(()=>new Promise(resolve=>resolvers.push(resolve)));
 const opts=options(3);const h=renderHook(({enabled})=>useOfficeMail({...opts,enabled}),{initialProps:{enabled:true}});expect(collaborationRequest).toHaveBeenCalledTimes(2);
 h.rerender({enabled:false});h.rerender({enabled:true});expect(collaborationRequest).toHaveBeenCalledTimes(2);
 await act(async()=>resolvers[0](page(1)));expect(collaborationRequest).toHaveBeenCalledTimes(3);expect(h.result.current.events).toEqual([]);
 h.unmount();await act(async()=>resolvers[1](page(2)));expect(collaborationRequest).toHaveBeenCalledTimes(3);
});
it('limits each source round to five pages then continues fixed highwater after 30 seconds',async()=>{
 vi.mocked(collaborationRequest).mockImplementation(async(_b,_p,r)=>{const after=r.operation==='inboxHeaders'?r.afterUid:0;return page(10,false,after+1)});
 const h=renderHook(()=>useOfficeMail(options()));await flush();await flush();expect(collaborationRequest).toHaveBeenCalledTimes(5);
 expect(vi.mocked(collaborationRequest).mock.calls[4][2]).toMatchObject({afterUid:4,throughUid:10});await act(async()=>vi.advanceTimersByTimeAsync(29999));expect(collaborationRequest).toHaveBeenCalledTimes(5);
 await act(async()=>vi.advanceTimersByTimeAsync(1));expect(collaborationRequest).toHaveBeenCalledTimes(10);h.unmount();
});
it('backs off transient failures and caches explicit unsupported until configuration changes',async()=>{
 vi.mocked(collaborationRequest).mockRejectedValue('connection lost');const opts=options();const h=renderHook(({input})=>useOfficeMail(input),{initialProps:{input:opts}});await flush();
 await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(collaborationRequest).toHaveBeenCalledTimes(2);await act(async()=>vi.advanceTimersByTimeAsync(59999));expect(collaborationRequest).toHaveBeenCalledTimes(2);
 vi.mocked(collaborationRequest).mockRejectedValue('协作服务 操作失败：usage: mailctl inbox\nerror: unrecognized arguments: --json --headers-only');await act(async()=>vi.advanceTimersByTimeAsync(1));expect(collaborationRequest).toHaveBeenCalledTimes(3);
 await act(async()=>vi.advanceTimersByTimeAsync(600000));expect(collaborationRequest).toHaveBeenCalledTimes(3);
 h.rerender({input:{...opts,sessions:opts.sessions.map(s=>({...s,backendId:'reconnected'}))}});await flush();expect(collaborationRequest).toHaveBeenCalledTimes(4);h.unmount();
});
it('discovers aliases once then polls their shared mailbox only once',async()=>{
 const h=renderHook(()=>useOfficeMail(options(2)));await flush();expect(collaborationRequest).toHaveBeenCalledTimes(2);
 vi.mocked(collaborationRequest).mockResolvedValue(page(1));await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(collaborationRequest).toHaveBeenCalledTimes(3);expect(h.result.current.events).toHaveLength(1);h.unmount();
});
it('drops failed transactions, retries from committed cursor and emits only final complete mail',async()=>{
 vi.mocked(collaborationRequest).mockResolvedValueOnce(page());const h=renderHook(()=>useOfficeMail(options()));await flush();
 vi.mocked(collaborationRequest).mockResolvedValueOnce(page(10,false,5)).mockRejectedValueOnce('offline');await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(h.result.current.events).toEqual([]);
 vi.mocked(collaborationRequest).mockResolvedValue(page(10));await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(vi.mocked(collaborationRequest).mock.lastCall?.[2]).toEqual({operation:'inboxHeaders',afterUid:0});expect(h.result.current.events.map(e=>e.uid)).toEqual([10]);h.unmount();
});
it('changed UIDVALIDITY silently rebaselines before allowing fresh deliveries',async()=>{
 vi.mocked(collaborationRequest).mockResolvedValue(page(100));const h=renderHook(()=>useOfficeMail(options()));await flush();
 const epochPage=(uid:number,next=uid)=>JSON.stringify({...JSON.parse(page(uid)),uidvalidity:2,next_after_uid:next,...(next>uid?{messages:[]}:{})});
 vi.mocked(collaborationRequest).mockResolvedValueOnce(epochPage(2,100)).mockResolvedValueOnce(epochPage(2));await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(h.result.current.events).toEqual([]);expect(vi.mocked(collaborationRequest).mock.lastCall?.[2]).toEqual({operation:'inboxHeaders',afterUid:0});
 vi.mocked(collaborationRequest).mockResolvedValue(epochPage(3));await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(h.result.current.events.map(e=>e.uid)).toEqual([3]);h.unmount();
});
