import {expect,it} from 'vitest';
import {initialMailMachine,nextMailRequest,parseInboxHeaders,reduceOfficeMail,unsupportedInbox,type InboxHeadersPage,type MailMachine,type MailSource} from '../src/lib/teamOfficeMail';
import {emptyProfile} from '../src/lib/collaboration';
const source:MailSource={id:'a',config:'one',backendId:'ssh',profile:emptyProfile()};
const page=(highwater:number,messages:InboxHeadersPage['messages']=[],complete=true,next=highwater,namespace='box'):InboxHeadersPage=>({namespace,account:"b@x",maximum:highwater,highwater,next,complete,messages});
const configure=(state=initialMailMachine(),sources=[source],active=true)=>reduceOfficeMail(state,{type:'configure',sources,active,now:0});
const receive=(state:MailMachine,p:InboxHeadersPage,now=0,id='a')=>reduceOfficeMail(reduceOfficeMail(state,{type:'page',request:nextMailRequest(state,id,now)!,page:p,now,directory:new Map([['a@x',[{kind:'station',sourceId:'cross-project',memberId:'sender'}]],['b@x',[{kind:'station',sourceId:'another',memberId:'recipient'}]]])}),{type:'flush',now});
const letter=(uid:number,kind='ack')=>({uid,from:'a@x',to:['b@x'],kind});
it('baselines history silently, commits pages atomically and ignores ping',()=>{
 let s=receive(configure(),page(10,[letter(10)]));expect(s.view.events).toEqual([]);
 s=receive(s,page(20,[letter(11)],false,11),30000);expect(s.partitions.box.committed).toBe(10);expect(s.view.sequence).toBe(0);
 s=receive(s,page(20,[letter(20,'ping')]),30000);expect(s.partitions.box.committed).toBe(20);expect(s.view.events).toEqual([expect.objectContaining({uid:11,from:{kind:'station',sourceId:'cross-project',memberId:'sender'},to:{kind:'station',sourceId:'another',memberId:'recipient'}})]);
});
it('failed pages discard transaction and preserve committed watermark',()=>{
 let s=receive(configure(),page(10));s=receive(s,page(20,[letter(11)],false,11),30000);
 s=reduceOfficeMail(s,{type:'failure',request:nextMailRequest(s,'a',30000)!,unsupported:false,now:30000});
 expect(s.sources.a.tx).toBeUndefined();expect(s.partitions.box.committed).toBe(10);expect(nextMailRequest(s,'a',59999)).toBeUndefined();expect(nextMailRequest(s,'a',60000)?.afterUid).toBe(10);
});
it('namespace aliases have a single owner and do not duplicate events',()=>{
 let s=configure(undefined,[source,{...source,id:'b'}]);const b=nextMailRequest(s,'b',0)!;
 s=receive(s,page(0));s=reduceOfficeMail(s,{type:'page',request:b,page:page(0),now:0,directory:new Map()});
 expect(nextMailRequest(s,'b',30000)).toBeUndefined();s=receive(s,page(1,[letter(1)]),30000);expect(s.view.events).toHaveLength(1);
});
it('hiding invalidates late responses and resume is a silent baseline',()=>{
 let s=receive(configure(),page(0));const old=nextMailRequest(s,'a',30000)!;
 s=configure(s,[source],false);s=reduceOfficeMail(s,{type:'page',request:old,page:page(2,[letter(2)]),now:30000,directory:new Map()});expect(s.partitions.box.committed).toBe(0);
 s=configure(s);s=receive(s,page(2,[letter(2)]),30000);expect(s.view.events).toEqual([]);expect(s.partitions.box.committed).toBe(2);
});
it('bounds staged candidates, counts overflow, yields after five pages',()=>{
 let s=receive(configure(),page(0));
 for(let i=1;i<=5;i++)s=receive(s,page(600,Array.from({length:100},(_,j)=>letter((i-1)*100+j+1)),false,i*100),30000);
 expect(s.sources.a.tx?.candidates).toHaveLength(5);expect(s.sources.a.tx?.count).toBe(500);expect(nextMailRequest(s,'a',30000)).toBeUndefined();
 s=receive(s,page(600,Array.from({length:100},(_,j)=>letter(501+j))),60000);expect(s.view.events).toHaveLength(5);expect(s.view.overflow).toBe(595);
});
it('changed UIDVALIDITY baselines the first observed maximum without scanning history',()=>{
 let s=receive(configure(),page(100));s=receive(s,page(2,[],true,100,'new-epoch'),30000);expect(nextMailRequest(s,'a',30000)).toBeUndefined();expect(s.partitions['new-epoch'].committed).toBe(2);
expect(s.view.events).toEqual([]);
});
it('ambiguous recipients resolve to edge, no private values enter DTO',()=>{
 let s=receive(configure(),page(0));s=reduceOfficeMail(s,{type:'page',request:nextMailRequest(s,'a',30000)!,page:page(1,[letter(1)]),now:30000,directory:new Map([['b@x',[{kind:'edge'},{kind:'edge'}]]])});
 s=reduceOfficeMail(s,{type:'flush',now:30000});expect(s.view.events).toEqual([]);expect(JSON.stringify(s.view)).not.toMatch(/a@x|b@x|box/);
});
const raw=(patch={})=>JSON.stringify({schema:'amail.inbox.headers.v1',namespace:{server:'imap',port:993,account:'a@x',mailbox:'INBOX'},uidvalidity:1,max_uid:1,highwater_uid:1,next_after_uid:1,complete:true,has_more:false,errors:[],messages:[letter(1)],...patch});
it.each([{errors:[{uid:1,code:'missing'}]},{messages:[letter(2)]},{next_after_uid:0,complete:false,has_more:true},{schema:'wrong'}])('rejects unsafe or incomplete protocol page %j',patch=>expect(()=>parseInboxHeaders(raw(patch),0)).toThrow());
it('accepts valid empty deleted-UID range and fixed watermark despite newer arrival',()=>{
 expect(parseInboxHeaders(raw({max_uid:5,highwater_uid:2,next_after_uid:2,messages:[]}),1,2).highwater).toBe(2);
});
it('unsupported requires failed argparse invocation rather than network or JSON text',()=>{
 expect(unsupportedInbox('协作服务 操作失败：usage: mailctl\nerror: unrecognized arguments: --json --headers-only')).toBe(true);
 expect(unsupportedInbox('network --json --headers-only')).toBe(false);
});
it('retains exponential failure history across successful partial pages',()=>{
 let s=receive(configure(),page(0));
 for(const [now,delay] of [[30000,30000],[60000,60000],[120000,120000],[240000,240000],[480000,300000]]){
  s=receive(s,page(10,[letter(1)],false,1),now);
  s=reduceOfficeMail(s,{type:'failure',request:nextMailRequest(s,'a',now)!,unsupported:false,now});
  expect(s.sources.a.due).toBe(now+delay);
 }
});
it('removed then re-added identical source rejects the previous incarnation response',()=>{
 let s=configure();const old=nextMailRequest(s,'a',0)!;s=configure(s,[]);s=configure(s);
 s=reduceOfficeMail(s,{type:'page',request:old,page:page(50),now:0,directory:new Map()});expect(s.partitions).toEqual({});
});
it('an old alias discovery cannot replay a watermark committed by a removed owner',()=>{
 const b={...source,id:'b'},c={...source,id:'c'};let s=configure(undefined,[source,b,c]);const pending=nextMailRequest(s,'b',0)!;
 s=receive(s,page(100));s=receive(s,page(100),0,'c');
 s=configure(s,[b,c]);s=reduceOfficeMail(s,{type:'page',request:pending,page:page(100,[letter(1)]),now:0,directory:new Map()});
 expect(s.view.events).toEqual([]);expect(nextMailRequest(s,'b',0)?.afterUid).toBe(100);
});
it('only header-classified heartbeat is suppressed and arbitrary kinds never enter DTO',()=>{
 expect(parseInboxHeaders(raw({messages:[{...letter(1),kind:'ping',classification_source:'subject'}]}),0).messages[0].kind).toBeNull();
 expect(parseInboxHeaders(raw({messages:[{...letter(1),kind:'ping',classification_source:'heartbeat_header'}]}),0).messages[0].kind).toBe('ping');
 expect(parseInboxHeaders(raw({messages:[{...letter(1),kind:'secret@example.test'}]}),0).messages[0].kind).toBeNull();
});
it('deleted mailbox tail never decreases the committed watermark',()=>{
 let s=receive(configure(),page(100));s=receive(s,page(0,[],true,100),30000);expect(s.partitions.box.committed).toBe(100);
 s=receive(s,page(101,[letter(101)]),60000);expect(s.view.events.map(e=>e.uid)).toEqual([101]);expect(nextMailRequest(s,'a',90000)?.afterUid).toBe(101);
});
it('a previous visibility generation cannot advance a resumed active mailbox',()=>{
 let s=receive(configure(),page(10));const stale=nextMailRequest(s,'a',30000)!;
 s=configure(s,[source],false);s=configure(s,[source],true);
 s=reduceOfficeMail(s,{type:'page',request:stale,page:page(20,[letter(20)]),now:30000,directory:new Map()});
 expect(s.partitions.box.committed).toBe(10);expect(s.sources.a.tx).toBeUndefined();
 s=receive(s,page(30,[letter(30)]),30000);expect(s.partitions.box.committed).toBe(30);expect(s.view.events).toEqual([]);
});
it.each(['invalid_header','missing_header'])('skips deterministic %s and delivers good messages on both sides atomically',code=>{
 let s=receive(configure(),page(0));
 const first=parseInboxHeaders(raw({max_uid:3,highwater_uid:3,next_after_uid:1,complete:false,has_more:true,errors:[{uid:2,code}],namespace:{server:'imap',port:993,account:'b@x',mailbox:'INBOX'}}),0);
 // Use the already discovered namespace so this is an incremental transaction.
 s.partitions[first.namespace]=s.partitions.box;delete s.partitions.box;s.sources.a.partition=first.namespace;
 s=receive(s,first,30000);expect(s.sources.a.failures).toBe(0);expect(s.partitions[first.namespace].committed).toBe(0);
 expect(nextMailRequest(s,'a',30000)).toMatchObject({afterUid:2,throughUid:3});
 s=receive(s,{...first,messages:[letter(3)],next:3,complete:true},30000);
 expect(s.view.events.map(e=>e.uid)).toEqual([1,3]);expect(s.partitions[first.namespace].committed).toBe(3);
});
it('skips a bad final UID without inventing a delivery and rejects unsafe error positions',()=>{
 const p=JSON.parse(raw({messages:[],next_after_uid:0,complete:false,has_more:true,errors:[{uid:1,code:'missing_header'}]}));
 expect(parseInboxHeaders(JSON.stringify(p),0).next).toBe(1);
 for(const error of [{uid:0,code:'invalid_header'},{uid:2,code:'invalid_header'},{uid:1,code:'fetch_failed'}])expect(()=>parseInboxHeaders(JSON.stringify({...p,errors:[error]}),0)).toThrow();
 expect(()=>parseInboxHeaders(JSON.stringify({...p,errors:[p.errors[0],p.errors[0]]}),0)).toThrow();
});
it('baselines an arbitrarily large first partial page directly at observed maximum',()=>{
 const s=receive(configure(),page(999999,[letter(1)],false,1));
 expect(s.partitions.box.committed).toBe(999999);expect(s.sources.a.tx).toBeUndefined();expect(nextMailRequest(s,'a',0)).toBeUndefined();expect(s.view.sequence).toBe(0);
});
it('uses only exact mailbox account once, ignoring multiple To and Cc-only recipients',()=>{
 let s=receive(configure(),page(0));s=receive(s,page(2,[{...letter(1),to:['other@x','another@x']},{...letter(2),to:[]}]),30000);
 expect(s.view.events.map(event=>event.uid)).toEqual([1,2]);expect(s.view.events).toHaveLength(2);expect(s.view.events.every(e=>e.to.kind==='station'&&e.to.memberId==='recipient')).toBe(true);
});
it('two real owner stations with the same address suppress delivery while ambiguous sender goes to edge',()=>{
 const one={kind:'station' as const,sourceId:'alpha',memberId:'one'},two={kind:'station' as const,sourceId:'beta',memberId:'two'};
 let s=receive(configure(),page(0));const request=nextMailRequest(s,'a',30000)!;
 const ambiguous=new Map([['b@x',[one,two]],['a@x',[one,two]]]);
 const rejected=reduceOfficeMail(s,{type:'page',request,page:page(1,[letter(1)]),now:30000,directory:ambiguous});expect(rejected.pending).toBeUndefined();expect(rejected.view.availability).toBe('ready');
 ambiguous.set('b@x',[one]);s=reduceOfficeMail(s,{type:'page',request,page:page(1,[letter(1)]),now:30000,directory:ambiguous});s=reduceOfficeMail(s,{type:'flush',now:30300});
 expect(s.view.events[0].from).toEqual({kind:'edge'});expect(s.view.events[0].to).toEqual(one);
});
it('network errors with the real command failure prefix are not unsupported',()=>{
 expect(unsupportedInbox('协作服务 操作失败：connection refused --json --headers-only')).toBe(false);
});
it('one ready source wins over another failed source and unprovisioned is unavailable without failures',()=>{
 let s=configure(undefined,[source,{...source,id:'b'}]);s=receive(s,page(0));
 s=reduceOfficeMail(s,{type:'failure',request:nextMailRequest(s,'b',0)!,unsupported:false,now:0});expect(s.view.availability).toBe('ready');
 let absent=configure();absent=reduceOfficeMail(absent,{type:'failure',request:nextMailRequest(absent,'a',0)!,unsupported:false,unavailable:true,now:0});expect(absent.view.availability).toBe('unavailable');expect(absent.sources.a.failures).toBe(0);expect(absent.sources.a.unsupported).toBe(false);expect(nextMailRequest(absent,'a',299999)).toBeUndefined();expect(nextMailRequest(absent,'a',300000)).toBeDefined();
});
it('switching to an existing mailbox partition never lowers its previous watermark',()=>{
 let s=configure(undefined,[source,{...source,id:'b'},{...source,id:'c'}]);s=receive(s,page(100));s=receive(s,page(100),0,'c');s=receive(s,page(10,[],true,10,'another'),0,'b');
 s=configure(s,[{...source,id:'b'},{...source,id:'c'}]);s=receive(s,page(0,[],true,10),30000,'b');expect(s.partitions.box.committed).toBe(100);
});
it('deterministic bad UID skip allows legal sparse SEARCH ranges',()=>{
 const p=parseInboxHeaders(raw({max_uid:9,highwater_uid:9,next_after_uid:1,complete:false,has_more:true,errors:[{uid:7,code:'missing_header'}]}),0);
 expect(p.next).toBe(7);expect(p.messages.map(m=>m.uid)).toEqual([1]);
 expect(parseInboxHeaders(raw({max_uid:9,highwater_uid:9,next_after_uid:9,messages:[letter(9)]}),7,9).messages[0].uid).toBe(9);
});
