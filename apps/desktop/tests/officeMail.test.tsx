import {act,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import TeamOffice from "../src/components/TeamOffice";
import type {OfficeMailEvent,OfficeMailView,OfficeSnapshot} from "../src/lib/teamOffice";
const member={id:"same-member",name:"Worker",isLead:false,status:{state:"working" as const,source:"program" as const,label:"工作中"},taskText:"Task",taskSource:"manual" as const,paletteKey:"a"};
const event=(id="a",kind="ack"):OfficeMailEvent=>({id,uid:1,kind,from:{kind:"station",sourceId:"one",memberId:member.id},to:{kind:"station",sourceId:"two",memberId:member.id}});
const mail=(sequence:number,events=[event()],extra:Partial<OfficeMailView>={}):OfficeMailView=>({sequence,reset:0,expiresAt:Date.now()+6000,events,overflow:0,availability:"ready",...extra});
const snapshot=(value=mail(1,[])):OfficeSnapshot=>({version:1,themeId:"one-light",animationEnabled:true,mailAvailability:"unavailable",mail:value,projects:[{id:"p1",name:"One",sources:[{id:"one",label:"First",availability:"ready",notice:"",members:[member]}]},{id:"p2",name:"Two",sources:[{id:"two",label:"Second",availability:"ready",notice:"",members:[member]}]}]});
let media:{matches:boolean;addEventListener:ReturnType<typeof vi.fn>;removeEventListener:ReturnType<typeof vi.fn>};
beforeEach(()=>{
 vi.useFakeTimers();vi.spyOn(document,"hidden","get").mockReturnValue(false);
 media={matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()};vi.stubGlobal("matchMedia",()=>media);
 vi.spyOn(HTMLElement.prototype,"clientWidth","get").mockReturnValue(600);
 vi.spyOn(SVGElement.prototype,"getBoundingClientRect").mockImplementation(function(this:SVGElement){
  const second=this.closest('[data-office-station]')?.getAttribute('data-office-station')?.includes('"two"');
  const scale=Number(this.closest('svg')?.getAttribute('width'))/28;
  const x=(second?330:30)+13*scale,y=(second?250:50)-3*scale,width=2*scale,height=scale;
  return {x,y,left:x,top:y,width,height,right:x+width,bottom:y+height,toJSON:()=>({})};
 });
 vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockImplementation(function(this:HTMLElement){
  const second=this.dataset.officeStation?.includes('"two"');const station=this.hasAttribute("data-office-station");
  const x=station?(second?330:30):10,y=station?(second?250:50):20,width=station?100:600,height=station?100:400;
  return {x,y,left:x,top:y,width,height,right:x+width,bottom:y+height,toJSON:()=>({})};
 });
});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals()});
it("starts each mounted room at the current sequence without replaying cached deliveries",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(screen.getByLabelText("确认邮件")).toBeTruthy();
 view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(screen.getAllByLabelText("确认邮件")).toHaveLength(1);
 view.unmount();render(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
});
it("clears on hiding and does not accumulate or replay batches on resume",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(screen.getByLabelText("确认邮件")).toBeTruthy();
 view.rerender(<TeamOffice snapshot={snapshot(mail(2))} visible={false}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(3))} visible={false}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(3))}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(4,[event("new","question")]))}/>);expect(screen.getByLabelText("提问邮件")).toBeTruthy();
});
it("expires stale batches, clears reset epochs and never replays a lower sequence",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2,[event()],{expiresAt:Date.now()-1}))}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(3))}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(4,[event()],{reset:1}))}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(2,[event()],{reset:1}))}/>);expect(screen.queryByLabelText("确认邮件")).toBeNull();
});
it("caps active deliveries at five, merges bounded overflow and keeps no replay queue",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2,Array.from({length:8},(_,i)=>event(String(i))),{overflow:1200}))}/>);
 expect(screen.getAllByLabelText("确认邮件")).toHaveLength(5);expect(screen.getByText("另有 +999 次投递")).toBeTruthy();
 view.rerender(<TeamOffice snapshot={snapshot(mail(3,[event("later","result")]))}/>);expect(screen.queryByLabelText("结果邮件")).toBeNull();
 act(()=>vi.advanceTimersByTime(1800));expect(view.container.querySelectorAll('[data-landed="true"]')).toHaveLength(5);
 act(()=>vi.advanceTimersByTime(3000));expect(view.container.querySelectorAll('.office-flying-mail')).toHaveLength(0);expect(screen.queryByText(/另有/)).toBeNull();
});
it("uses source plus member anchors across rows and recomputes scrolling and scale layout",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);
 const letter=screen.getByLabelText("确认邮件");expect(letter.getAttribute("data-from-edge")).toBe("false");expect(letter.getAttribute("data-to-edge")).toBe("false");
 expect(letter.style.getPropertyValue("--mail-from-x")).toBe("33px");expect(letter.style.getPropertyValue("--mail-to-y")).toBe("196px");
 const scroller=view.container.querySelector('.office-projects')!;Object.defineProperty(scroller,"scrollTop",{configurable:true,value:120});fireEvent.scroll(scroller);expect(letter.style.getPropertyValue("--mail-to-y")).toBe("316px");
 fireEvent.change(screen.getByRole("combobox",{name:"房间像素缩放"}),{target:{value:"3"}});expect(letter.getAttribute("data-to-edge")).toBe("false");expect(letter.style.getPropertyValue("--mail-from-x")).toBe("39.5px");
});
it("falls back to the mailbox edge after a destination is collapsed or removed",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);fireEvent.click(screen.getByRole("button",{name:"折叠项目 Two"}));expect(screen.getByLabelText("确认邮件").getAttribute("data-to-edge")).toBe("true");
 const next=snapshot(mail(2));next.projects.splice(1,1);view.rerender(<TeamOffice snapshot={next}/>);expect(screen.getByLabelText("确认邮件").getAttribute("data-to-edge")).toBe("true");
});
it("uses static delivery markers for settings off and actual reduced motion changes",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={{...snapshot(mail(2)),animationEnabled:false}}/>);expect(view.container.querySelector('.office-mail-layer')?.getAttribute("data-mail-motion")).toBe("off");expect(screen.getByLabelText("确认邮件").getAttribute("data-static")).toBe("true");
 view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(screen.getByLabelText("确认邮件").getAttribute("data-static")).toBe("true");expect(view.container.querySelector('.office-mail-layer')?.getAttribute("data-mail-motion")).toBe("on");
 act(()=>{media.matches=true;media.addEventListener.mock.calls[0][1]()});expect(view.container.querySelector('.office-mail-layer')?.getAttribute("data-mail-motion")).toBe("off");
});
it("clears on document visibility and leaves no running timers after unmount",()=>{
 const hidden=vi.spyOn(document,"hidden","get");const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);
 hidden.mockReturnValue(true);fireEvent(document,new Event("visibilitychange"));expect(screen.queryByLabelText("确认邮件")).toBeNull();expect(vi.getTimerCount()).toBe(0);view.unmount();expect(vi.getTimerCount()).toBe(0);
});

it("uses each new batch overflow directly and does not replay ordinary rerenders",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);view.rerender(<TeamOffice snapshot={snapshot(mail(2,[event("old")],{overflow:2}))}/>);expect(screen.queryByText("另有 +2 次投递")).not.toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(3,[event("fresh","result")],{overflow:2}))}/>);expect(screen.getByLabelText("确认邮件")).toBeTruthy();expect(screen.getByLabelText("结果邮件")).toBeTruthy();expect(screen.queryByText("另有 +2 次投递")).not.toBeNull();
 view.rerender(<TeamOffice snapshot={snapshot(mail(3,[event("fresh","result")],{overflow:2}))}/>);expect(screen.getAllByLabelText("结果邮件")).toHaveLength(1);
 view.rerender(<TeamOffice snapshot={snapshot(mail(4,[event("next")],{overflow:0}))}/>);expect(screen.queryByText(/另有/)).toBeNull();
 act(()=>vi.advanceTimersByTime(6000));view.rerender(<TeamOffice snapshot={snapshot(mail(5,[event("after-window")],{overflow:2}))}/>);expect(screen.queryByText("另有 +2 次投递")).not.toBeNull();
});
it("does not attach geometry listeners without deliveries and removes them after expiry",()=>{
 const add=vi.spyOn(EventTarget.prototype,"addEventListener"),remove=vi.spyOn(EventTarget.prototype,"removeEventListener");
 const view=render(<TeamOffice snapshot={snapshot()}/>);const root=view.container.querySelector('.office-projects');
 const geometry=()=>add.mock.calls.filter((args,i)=>(args[0]==='resize'&&add.mock.contexts[i]===window)||(args[0]==='scroll'&&add.mock.contexts[i]===root));
 expect(geometry()).toHaveLength(0);view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(geometry().length).toBeGreaterThan(0);
 act(()=>vi.advanceTimersByTime(4000));const count=geometry().length;view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(geometry()).toHaveLength(count);expect(remove.mock.calls.some(args=>args[0]==='scroll')).toBe(true);
});
it("falls back when an anchor is horizontally outside the scrolling viewport",()=>{
 const view=render(<TeamOffice snapshot={snapshot()}/>);const target=view.container.querySelectorAll('[data-avatar-mail-anchor]')[1]!;
 vi.spyOn(target,"getBoundingClientRect").mockReturnValue({x:900,y:50,left:900,top:50,width:100,height:100,right:1000,bottom:150,toJSON:()=>({})});
 view.rerender(<TeamOffice snapshot={snapshot(mail(2))}/>);expect(screen.getByLabelText("确认邮件").getAttribute("data-to-edge")).toBe("true");
});
