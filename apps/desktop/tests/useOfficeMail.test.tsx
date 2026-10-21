import {act,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {useOfficeMail} from '../src/lib/useOfficeMail';
import {collaborationRequest,collaborationKey,emptyProfile} from '../src/lib/collaboration';
vi.mock('../src/lib/collaboration',async original=>({...await original<any>(),collaborationRequest:vi.fn()}));
const server={id:'remote',name:'Remote',host:'example.test',port:22,username:'dev',authMethod:'password' as const};
const profile={...emptyProfile(),enabled:true,mailEnabled:true,project:'alpha',workdir:'/repo',tmuxId:'$1',tmuxCreated:100,tmuxName:'lead'};
const options=(count=1)=>({enabled:true,profiles:Object.fromEntries(Array.from({length:count},(_,i)=>{const p={...profile,tmuxId:`$${i+1}`};return [collaborationKey(server.id,p),p]})),servers:[server],sessions:[{pane:{id:'pane',server,tmux:{id:'$1',created:100,name:'lead'}},backendId:'ssh'}],directory:{current:new Map([['test',[{kind:'station' as const,sourceId:'source',memberId:'owner'}]]])}});
const page=(uid=0,complete=true,next=uid)=>JSON.stringify({schema:'amail.inbox.headers.v1',namespace:{server:'imap',port:993,account:'test',mailbox:'INBOX'},uidvalidity:1,max_uid:uid,highwater_uid:uid,next_after_uid:next,complete,has_more:!complete,errors:[],messages:uid&&complete?[{uid,from:'sender@x',to:['recipient@x'],kind:'ack'}]:[]});
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);vi.mocked(collaborationRequest).mockReset().mockResolvedValue(page());});
afterEach(()=>{vi.useRealTimers()});
const flush=async()=>act(async()=>{await Promise.resolve();await Promise.resolve()});
it('mounts inactive without any remote calls, polls every 30 seconds and baselines first pull',async()=>{
 const opts=options();const h=renderHook(({enabled})=>useOfficeMail({...opts,enabled}),{initialProps:{enabled:false}});await flush();expect(collaborationRequest).not.toHaveBeenCalled();
 h.rerender({enabled:true});await flush();expect(collaborationRequest).toHaveBeenCalledTimes(1);expect(h.result.current.sequence).toBe(0);
 vi.mocked(collaborationRequest).mockResolvedValue(page(1));await act(async()=>vi.advanceTimersByTimeAsync(30300));expect(collaborationRequest).toHaveBeenCalledTimes(2);expect(h.result.current.events).toHaveLength(1);h.unmount();
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
 vi.mocked(collaborationRequest).mockResolvedValueOnce(page());
 const h=renderHook(()=>useOfficeMail(options()));await flush();await act(async()=>vi.advanceTimersByTimeAsync(30000));await flush();expect(collaborationRequest).toHaveBeenCalledTimes(6);
 expect(vi.mocked(collaborationRequest).mock.calls[5][2]).toMatchObject({afterUid:4,throughUid:10});await act(async()=>vi.advanceTimersByTimeAsync(29999));expect(collaborationRequest).toHaveBeenCalledTimes(6);
 await act(async()=>vi.advanceTimersByTimeAsync(1));expect(collaborationRequest).toHaveBeenCalledTimes(11);h.unmount();
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
 vi.mocked(collaborationRequest).mockResolvedValue(page(1));await act(async()=>vi.advanceTimersByTimeAsync(30300));expect(collaborationRequest).toHaveBeenCalledTimes(3);expect(h.result.current.events).toHaveLength(1);h.unmount();
});
it('drops failed transactions, retries from committed cursor and emits only final complete mail',async()=>{
 vi.mocked(collaborationRequest).mockResolvedValueOnce(page());const h=renderHook(()=>useOfficeMail(options()));await flush();
 vi.mocked(collaborationRequest).mockResolvedValueOnce(page(10,false,5)).mockRejectedValueOnce('offline');await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(h.result.current.events).toEqual([]);
 vi.mocked(collaborationRequest).mockResolvedValue(page(10));await act(async()=>vi.advanceTimersByTimeAsync(30300));expect(vi.mocked(collaborationRequest).mock.lastCall?.[2]).toEqual({operation:'inboxHeaders',afterUid:0});expect(h.result.current.events.map(e=>e.uid)).toEqual([10]);h.unmount();
});
it('changed UIDVALIDITY silently rebaselines before allowing fresh deliveries',async()=>{
 vi.mocked(collaborationRequest).mockResolvedValue(page(100));const h=renderHook(()=>useOfficeMail(options()));await flush();
 const epochPage=(uid:number,next=uid)=>JSON.stringify({...JSON.parse(page(uid)),uidvalidity:2,next_after_uid:next,...(next>uid?{messages:[]}:{})});
 vi.mocked(collaborationRequest).mockResolvedValueOnce(epochPage(2,100));await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(h.result.current.events).toEqual([]);expect(vi.mocked(collaborationRequest).mock.lastCall?.[2]).toEqual({operation:'inboxHeaders',afterUid:100});
 vi.mocked(collaborationRequest).mockResolvedValue(epochPage(3));await act(async()=>vi.advanceTimersByTimeAsync(30300));expect(h.result.current.events.map(e=>e.uid)).toEqual([3]);h.unmount();
});
it('coalesces two simultaneous source commits into one bounded batch with direct overflow',async()=>{
 let fresh=false;
 vi.mocked(collaborationRequest).mockImplementation(async(_backend,p)=>JSON.stringify({...JSON.parse(page(fresh?4:0)),namespace:{server:p.tmuxId,port:993,account:'test',mailbox:'INBOX'},messages:fresh?[1,2,3,4].map(uid=>({uid,from:'sender@x',to:['other@x','another@x'],kind:'ack'})):[]}));
 const h=renderHook(()=>useOfficeMail(options(2)));await flush();fresh=true;
 await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(h.result.current.sequence).toBe(0);
 await act(async()=>vi.advanceTimersByTimeAsync(299));expect(h.result.current.sequence).toBe(0);
 await act(async()=>vi.advanceTimersByTimeAsync(1));expect(h.result.current.sequence).toBe(1);expect(h.result.current.events).toHaveLength(5);expect(h.result.current.overflow).toBe(3);
 expect(new Set(h.result.current.events.map(e=>e.id)).size).toBe(5);h.unmount();
});
it('publishes separate batches across fixed merge windows without replaying the first batch',async()=>{
 let fresh=false;let second!:(value:string)=>void;
 const result=(name:string,uid:number)=>JSON.stringify({...JSON.parse(page(uid)),namespace:{server:name,port:993,account:'test',mailbox:'INBOX'}});
 vi.mocked(collaborationRequest).mockImplementation(async(_backend,p)=>!fresh?result(p.tmuxId,0):p.tmuxId==='$1'?result(p.tmuxId,1):new Promise(resolve=>{second=resolve}));
 const h=renderHook(()=>useOfficeMail(options(2)));await flush();fresh=true;
 await act(async()=>vi.advanceTimersByTimeAsync(30300));expect(h.result.current.sequence).toBe(1);expect(h.result.current.events.map(e=>e.uid)).toEqual([1]);
 await act(async()=>vi.advanceTimersByTimeAsync(1));await act(async()=>second(result('$2',2)));
 await act(async()=>vi.advanceTimersByTimeAsync(300));expect(h.result.current.sequence).toBe(2);expect(h.result.current.events.map(e=>e.uid)).toEqual([2]);expect(h.result.current.overflow).toBe(0);h.unmount();
});
it('continues beyond a malformed header without backoff and delivers both good messages',async()=>{
 const h=renderHook(()=>useOfficeMail(options()));await flush();
 vi.mocked(collaborationRequest).mockResolvedValueOnce(JSON.stringify({...JSON.parse(page(3,false,1)),messages:[{uid:1,from:'sender@x',to:[],kind:'ack'}],errors:[{uid:2,code:'invalid_header'}]})).mockResolvedValueOnce(page(3));
 await act(async()=>vi.advanceTimersByTimeAsync(30300));expect(collaborationRequest).toHaveBeenCalledTimes(3);
 expect(vi.mocked(collaborationRequest).mock.lastCall?.[2]).toEqual({operation:'inboxHeaders',afterUid:2,throughUid:3});expect(h.result.current.events.map(e=>e.uid)).toEqual([1,3]);expect(h.result.current.availability).toBe('ready');h.unmount();
});
it('cancels an unflushed batch on hide and silently baselines on resume',async()=>{
 const opts=options();const h=renderHook(({enabled})=>useOfficeMail({...opts,enabled}),{initialProps:{enabled:true}});await flush();vi.mocked(collaborationRequest).mockResolvedValue(page(1));
 await act(async()=>vi.advanceTimersByTimeAsync(30000));h.rerender({enabled:false});await act(async()=>vi.advanceTimersByTimeAsync(300));expect(h.result.current.events).toEqual([]);expect(h.result.current.sequence).toBe(0);
 h.rerender({enabled:true});await flush();await act(async()=>vi.advanceTimersByTimeAsync(300));expect(h.result.current.events).toEqual([]);h.unmount();
});
it('rechecks an unprovisioned mailbox after five minutes and baselines without changing its configuration',async()=>{
 vi.mocked(collaborationRequest).mockRejectedValueOnce('协作服务 操作失败：mailbox is not provisioned').mockResolvedValue(page(100));
 const h=renderHook(()=>useOfficeMail(options()));await flush();expect(h.result.current.availability).toBe('unavailable');
 await act(async()=>vi.advanceTimersByTimeAsync(299999));expect(collaborationRequest).toHaveBeenCalledTimes(1);
 await act(async()=>vi.advanceTimersByTimeAsync(1));expect(collaborationRequest).toHaveBeenCalledTimes(2);expect(h.result.current.availability).toBe('ready');
 await act(async()=>vi.advanceTimersByTimeAsync(300));expect(h.result.current.events).toEqual([]);expect(h.result.current.sequence).toBe(0);h.unmount();
});
it('does not probe an unprovisioned mailbox while hidden and silently recovers when visible',async()=>{
 vi.mocked(collaborationRequest).mockRejectedValueOnce('协作服务 操作失败：mailbox is not provisioned').mockResolvedValue(page(100));
 const opts=options();const h=renderHook(({enabled})=>useOfficeMail({...opts,enabled}),{initialProps:{enabled:true}});await flush();h.rerender({enabled:false});
 await act(async()=>vi.advanceTimersByTimeAsync(600000));expect(collaborationRequest).toHaveBeenCalledTimes(1);
 h.rerender({enabled:true});await flush();expect(collaborationRequest).toHaveBeenCalledTimes(2);expect(h.result.current.availability).toBe('ready');
 await act(async()=>vi.advanceTimersByTimeAsync(300));expect(h.result.current.events).toEqual([]);h.unmount();
});
