import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import TeamServiceAi from '../src/components/TeamServiceAi';
import TeamOffice from '../src/components/TeamOffice';
import {buildOfficeSnapshot} from '../src/lib/teamOffice';
import {emptyProfile} from '../src/lib/collaboration';
import {serviceAi,type ServiceAi} from '../src/lib/serviceAi';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async()=>()=>{})}));
const ai:ServiceAi={status:'working',summary:'Testing storage',evidence:'<script>window.stolen=true</script><img src=x onerror="window.stolen=true">',model:'example-model',updatedAt:'2026-10-25T00:00:00Z'};
const target={project:'demo',key:'worker@example.invalid',identity:'https://team.example.invalid/demo'};
beforeEach(()=>{vi.mocked(invoke).mockReset();vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-25T00:02:00Z'));});
afterEach(()=>{cleanup();vi.useRealTimers();});
async function request(){await act(async()=>fireEvent.click(screen.getByRole('button',{name:'重新总结'})));}
it('renders service fields and literal hostile evidence without active DOM',()=>{
 const {container}=render(<TeamServiceAi ai={ai} target={target}/>);
 expect(screen.getByText('Testing storage')).toBeTruthy();expect(screen.getByText('工作中 · AI · example-model · 2 分钟前')).toBeTruthy();
 fireEvent.click(screen.getByText('AI 摘要依据'));
 expect(container.querySelector('pre')?.textContent).toBe(ai.evidence);
 expect(container.querySelector('script,img')).toBeNull();
});
it('keeps accepted summary unchanged until supplied by the service',async()=>{
 vi.mocked(invoke).mockResolvedValue({status:202,code:'accepted'});
 const view=render(<TeamServiceAi ai={ai} target={target}/>);await request();
 expect(screen.getByText('已请求，等待服务更新')).toBeTruthy();expect(screen.getByText(ai.summary)).toBeTruthy();
 expect(invoke).toHaveBeenCalledExactlyOnceWith('team_service_ai_refresh',{project:target.project,key:target.key});
 view.rerender(<TeamServiceAi ai={{...ai,summary:'New service summary'}} target={target}/>);
 expect(screen.getByText('New service summary')).toBeTruthy();expect(screen.queryByText(ai.summary)).toBeNull();expect(screen.queryByText('已请求，等待服务更新')).toBeNull();
});
it('disables refresh through Retry-After and enables at the deadline',async()=>{
 vi.mocked(invoke).mockResolvedValue({status:429,code:'rate_limited',retry_after:3});render(<TeamServiceAi target={target}/>);await request();
 const button=screen.getByRole('button');expect((button as HTMLButtonElement).disabled).toBe(true);expect(button.textContent).toContain('3 秒');
 fireEvent.click(button);expect(invoke).toHaveBeenCalledTimes(1);
 await act(async()=>vi.advanceTimersByTime(2000));expect((button as HTMLButtonElement).disabled).toBe(true);expect(button.textContent).toContain('1 秒');
 await act(async()=>vi.advanceTimersByTime(1000));expect((button as HTMLButtonElement).disabled).toBe(false);
});
it('uses conservative 30 seconds for a missing Retry-After',async()=>{
 vi.mocked(invoke).mockResolvedValue({status:429,code:'budget_exhausted'});render(<TeamServiceAi target={target}/>);await request();expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);expect(screen.getByRole('button').textContent).toContain('30 秒');
});
it.each([1, 3600, 4000000000, Number.MAX_VALUE])('bounds positive integer cooldown %s and releases at its deadline',async(value)=>{
 vi.mocked(invoke).mockResolvedValue({status:429,code:'rate_limited',retry_after:value});
 render(<TeamServiceAi target={target}/>);await request();
 const seconds=Math.min(value,3600);const button=screen.getByRole('button') as HTMLButtonElement;
 expect(button.textContent).toContain(`${seconds} 秒`);expect(button.disabled).toBe(true);
 await act(async()=>vi.advanceTimersByTime((seconds-1)*1000));
 expect(button.textContent).toContain('1 秒');expect(button.disabled).toBe(true);
 await act(async()=>vi.advanceTimersByTime(1000));expect(button.disabled).toBe(false);
});
it.each([0,-1,1.5,NaN,Infinity,'3',null])('defaults invalid cooldown %s to 30 seconds',async(value)=>{
 vi.mocked(invoke).mockResolvedValue({status:429,code:'rate_limited',retry_after:value});
 render(<TeamServiceAi target={target}/>);await request();
 const button=screen.getByRole('button') as HTMLButtonElement;
 expect(button.textContent).toContain('30 秒');expect(button.disabled).toBe(true);
 await act(async()=>vi.advanceTimersByTime(29000));expect(button.disabled).toBe(true);
 await act(async()=>vi.advanceTimersByTime(1000));expect(button.disabled).toBe(false);
});
it('shows no-live-session and disabled messages without exposing error fields',async()=>{
 vi.mocked(invoke).mockResolvedValue({status:409,code:'no_live_session',token:'SECRET'});const view=render(<TeamServiceAi target={target}/>);await request();
 expect(screen.getByText('该成员当前没有在线会话')).toBeTruthy();expect(document.body.textContent).not.toContain('SECRET');
 vi.mocked(invoke).mockResolvedValue({status:503,code:'ai_disabled'});await request();expect(screen.getByText('AI 摘要未启用')).toBeTruthy();
 view.rerender(<TeamServiceAi target={target} enabled={false}/>);expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
});
it('shows empty and explicitly disabled capabilities separately',()=>{
 const view=render(<TeamServiceAi/>);expect(screen.getByText('暂无 AI 摘要')).toBeTruthy();view.rerender(<TeamServiceAi enabled={false}/>);expect(screen.getByText('AI 摘要未启用')).toBeTruthy();expect(screen.queryByText('暂无 AI 摘要')).toBeNull();
});
it('ignores a late old identity response and clears countdowns on unmount',async()=>{
 let finish!:(value:unknown)=>void;vi.mocked(invoke).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
 const view=render(<TeamServiceAi target={target}/>);await request();view.rerender(<TeamServiceAi target={{...target,project:'other',identity:'other'}}/>);
 await act(async()=>finish({status:429,code:'rate_limited',retry_after:100}));expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false);expect(screen.queryByText(/请求受限/)).toBeNull();
 vi.mocked(invoke).mockResolvedValue({status:429,code:'rate_limited',retry_after:3});await request();expect(vi.getTimerCount()).toBe(1);view.unmount();expect(vi.getTimerCount()).toBe(0);
});
it('does not render arbitrary rejection bodies',async()=>{
 vi.mocked(invoke).mockRejectedValue({status:500,code:'SECRET_BODY',token:'SECRET_TOKEN'});render(<TeamServiceAi target={target}/>);await request();expect(screen.getByText('重新总结失败，请稍后重试')).toBeTruthy();expect(document.body.textContent).not.toMatch(/SECRET/);
});
it('carries only AI presentation fields into the room and offers no refresh command there',()=>{
 const member={project:'demo',email:target.key,role:'Worker',host:'host-a',port:22,username:'dev',workdir:'/srv/example',tmux:{id:'$1',created:1,name:'worker'}};
 const snapshot=buildOfficeSnapshot([{id:'source',project:'demo',label:'Demo',profile:emptyProfile(),service:true}],{source:{availability:'ready',notice:'',members:[member],ai:{[target.key]:{...ai,digest:'PRIVATE_DIGEST',source:{machine:'PRIVATE_HOST',session:'PRIVATE_SESSION'}}}}},{servers:[],sessions:[],themeId:'one-light',animationEnabled:false});
 expect(Object.keys(snapshot.projects[0].sources[0].members[0].ai!).sort()).toEqual(["evidence","model","status","summary","updatedAt"]);
 expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|worker@example|host-a/);
 render(<TeamOffice snapshot={snapshot}/>);const station=document.querySelector('.office-station')!;expect(within(station as HTMLElement).getByText(ai.summary)).toBeTruthy();expect(within(station as HTMLElement).getByText(/AI · example-model/)).toBeTruthy();expect(screen.queryByRole('button',{name:'重新总结'})).toBeNull();
});

it('rejects malformed AI dates and unknown states instead of rendering invalid relative time',()=>{
 expect(serviceAi({...ai,updatedAt:'invalid'})).toBeUndefined();expect(serviceAi({...ai,status:'invented'})).toBeUndefined();
 render(<TeamServiceAi ai={serviceAi({...ai,updatedAt:'invalid'})}/>);expect(screen.getByText('暂无 AI 摘要')).toBeTruthy();expect(document.body.textContent).not.toContain('NaN');
});
