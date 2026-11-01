import {act, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {beforeEach, expect, it, vi} from 'vitest';
const mock=vi.hoisted(()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mock.invoke}));
import TaskLookup, {TaskBrowser} from '../src/components/TaskLookup';
import {boardSource,defaultLookupSettings,clearBoardCache} from '../src/lib/taskLookup';
const source=boardSource({...defaultLookupSettings(),boardUrl:'http://board.test'})!;
let denied=false;
const catalog=[{slug:'parent'},{slug:'child',parent:'parent'},{slug:'leaf',parent:'child'},{slug:'alone'}];
beforeEach(()=>{clearBoardCache();denied=false;mock.invoke.mockClear();mock.invoke.mockImplementation(async (cmd:string,args:{path:string})=>{
 if(cmd!=='taskboard_get')return;
 const project=args.path.split('/')[4];
 const data=args.path==='/api/v1/projects'?{projects:catalog}:args.path.endsWith('/statuses')?{statuses:[{key:'doing',name:'进行中',color:'#123456'},{key:'done',name:'完成',color:'#123456'}]}:{tasks:[{code:'T1',title:project+' task',assignee:project==='child'?'reviewer':'worker',status_key:project==='parent'?'done':'doing',updated_at:''}]};
 return {status:denied&&project==='child'&&args.path.endsWith('/tasks')?403:200,body:JSON.stringify(data)};
});});
async function open(project='parent'){
 const onOpen=vi.fn();render(<TaskBrowser source={source} project={project} slugs={catalog.map(p=>p.slug)} onOpen={onOpen}/>);
 const details=screen.getByText(new RegExp('浏览 '+project)).closest('details')!;
 await act(async()=>{details.open=true;fireEvent(details,new Event('toggle'));});
 await screen.findByLabelText('按状态筛选');return onOpen;
}
it('merges descendants recursively, distinguishes same codes and combines project filters',async()=>{
 const onOpen=await open();
 expect(document.querySelectorAll('.task-list-row')).toHaveLength(3);
 expect(screen.getByTitle('parent/T1')).toBeTruthy();expect(screen.getByTitle('leaf/T1')).toBeTruthy();
 fireEvent.click(screen.getByTitle('child/T1'));expect(onOpen).toHaveBeenCalledWith('T1','child');
 fireEvent.change(screen.getByLabelText('按状态筛选'),{target:{value:'doing'}});
 expect(document.querySelectorAll('.task-list-row')).toHaveLength(2);
 fireEvent.change(screen.getByLabelText('按负责人筛选'),{target:{value:'worker'}});
 expect(document.querySelectorAll('.task-list-row')).toHaveLength(1);
 fireEvent.change(screen.getByLabelText('按项目筛选'),{target:{value:'child'}});
 expect(document.querySelectorAll('.task-list-row')).toHaveLength(0);
 fireEvent.change(screen.getByLabelText('按项目筛选'),{target:{value:'leaf'}});
 fireEvent.change(screen.getByLabelText('按状态筛选'),{target:{value:'doing'}});
 fireEvent.change(screen.getByLabelText('按负责人筛选'),{target:{value:'worker'}});
 fireEvent.change(screen.getByLabelText('搜索标题'),{target:{value:'leaf'}});
 expect(document.querySelectorAll('.task-list-row')).toHaveLength(1);
 expect(screen.getByTitle('leaf/T1')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('搜索标题'),{target:{value:'missing'}});
 expect(document.querySelectorAll('.task-list-row')).toHaveLength(0);
});
it('keeps readable projects on child 403 and retries all projects on refresh',async()=>{
 denied=true;await open();expect(document.querySelectorAll('.task-list-row')).toHaveLength(2);
 expect(screen.getByRole('alert').textContent).toContain('child');
 mock.invoke.mockClear();
 denied=false;fireEvent.click(screen.getByText('刷新'));
 await waitFor(()=>expect(document.querySelectorAll('.task-list-row')).toHaveLength(3));
 expect(screen.queryByRole('alert')).toBeNull();
 const paths=mock.invoke.mock.calls.map(call=>call[1].path);
 expect(paths).toContain('/api/v1/projects');
 for(const project of ['parent','child','leaf']) expect(paths).toContain(`/api/v1/projects/${project}/tasks`);
});
it('keeps a childless project scoped to its own task',async()=>{
 await open('alone');expect(document.querySelectorAll('.task-list-row')).toHaveLength(1);
 expect(screen.queryByLabelText('按项目筛选')).toBeNull();
});

it('opens a child card through the integrated lookup with its owning project',async()=>{
 const onOpen=vi.fn();render(<TaskLookup source={source} inferred={{project:'parent',reason:'team'}} onOpenTaskDetail={onOpen}/>);
 const details=screen.getByText(/浏览 parent/).closest('details')!;
 await act(async()=>{details.open=true;fireEvent(details,new Event('toggle'));});
 fireEvent.click(await screen.findByTitle('child/T1'));
 expect(onOpen).toHaveBeenCalledWith('child','T1');
});
