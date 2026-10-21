import {expect,it} from 'vitest';
import {initialMailMachine,nextMailRequest,parseInboxHeaders,reduceOfficeMail,unsupportedInbox,type InboxHeadersPage,type MailMachine,type MailSource} from '../src/lib/teamOfficeMail';
import {emptyProfile} from '../src/lib/collaboration';
const source:MailSource={id:'a',config:'one',backendId:'ssh',profile:emptyProfile()};
const page=(highwater:number,messages:InboxHeadersPage['messages']=[],complete=true,next=highwater,namespace='box'):InboxHeadersPage=>({namespace,highwater,next,complete,messages});
const configure=(state=initialMailMachine(),sources=[source],active=true)=>reduceOfficeMail(state,{type:'configure',sources,active,now:0});
const receive=(state:MailMachine,p:InboxHeadersPage,now=0,id='a')=>reduceOfficeMail(state,{type:'page',request:nextMailRequest(state,id,now)!,page:p,now,directory:new Map([['a@x',[{kind:'station',sourceId:'cross-project',memberId:'sender'}]],['b@x',[{kind:'station',sourceId:'another',memberId:'recipient'}]]])});
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
it('changed UIDVALIDITY restarts from zero and baselines silently',()=>{
 let s=receive(configure(),page(100));s=receive(s,page(2,[],true,100,'new-epoch'),30000);expect(nextMailRequest(s,'a',30000)?.afterUid).toBe(0);
 s=receive(s,page(2,[letter(2)],true,2,'new-epoch'),30000);expect(s.view.events).toEqual([]);
});
it('ambiguous recipients resolve to edge, no private values enter DTO',()=>{
 let s=receive(configure(),page(0));s=reduceOfficeMail(s,{type:'page',request:nextMailRequest(s,'a',30000)!,page:page(1,[letter(1)]),now:30000,directory:new Map([['b@x',[{kind:'edge'},{kind:'edge'}]]])});
 expect(s.view.events[0].to).toEqual({kind:'edge'});expect(JSON.stringify(s.view)).not.toMatch(/a@x|b@x|box/);
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
