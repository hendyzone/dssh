import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const css = readFileSync(`${process.cwd()}/src/components/TaskLookup.css`, "utf8");
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
import TaskLookup from "../src/components/TaskLookup";
import { boardSource, clearBoardCache, defaultLookupSettings } from "../src/lib/taskLookup";
const source = boardSource({ ...defaultLookupSettings(), boardUrl: "https://board.example.invalid" })!;
const acceptance = Array.from({length:8}, (_, i) => `验收步骤 ${i + 1}`).join("\n");
const task = (code: string) => ({code,title:`${code} a long title that should stay on one line`,assignee:"example-worker-with-long-name@example.invalid",status_key:"doing",updated_at:"2026-01-01T00:00:00Z",status_changed_at:"2026-01-01T00:00:00Z",summary:"Summary",acceptance,detail:"Details"});
const response = (path: string) => ({status:200,body:JSON.stringify(
  path === "/api/v1/projects" ? {projects:[{slug:"demo",name:"Demo",archived:false}]} :
  path.endsWith("/statuses") ? {statuses:[{key:"doing",name:"进行中"}]} :
  path.endsWith("/dependencies") ? {dependencies:[]} :
  path.endsWith("/tasks") ? {tasks:[task("T1"),task("T2")]} : task(path.split("/").at(-1)!)
)});
beforeEach(() => { localStorage.clear();clearBoardCache();bridge.invoke.mockReset();bridge.invoke.mockImplementation(async (_command,args) => response(args.path)); });
async function browser() {
  render(<TaskLookup source={source} inferred={{project:"demo",reason:"team"}}/>);
  const details = screen.getByText(/浏览 demo/).closest("details")!;
  await act(async () => { details.open=true;fireEvent(details,new Event("toggle")); });
  await screen.findByLabelText("按状态筛选");
  const list = details.querySelector(".task-list") as HTMLDivElement;
  return {list, row:(code:string) => within(list).getByText(code).closest("button")!};
}
it("renders four distinct centered columns with full title and assignee tooltips", async () => {
  const {row}=await browser();const item=row("T1");
  expect(Array.from(item.children).map(child=>child.className)).toEqual(["task-list-status","tb-card-code task-list-code","task-list-title","task-list-who"]);
  expect(item.querySelector(".task-list-title")?.getAttribute("title")).toBe(task("T1").title);
  expect(item.querySelector(".task-list-who")?.getAttribute("title")).toBe(task("T1").assignee);
  expect(css).toMatch(/\.task-list>\.task-list-row\{[^}]*min-height:32px/);
  expect(css).toMatch(/\.task-list-title\{[^}]*min-width:0;[^}]*text-overflow:ellipsis/);
  expect(css).toContain("container:task-browser / inline-size");
  expect(css).toMatch(/@container task-browser \(max-width:360px\)[\s\S]*grid-template-areas:"status code title" "\. \. who"/);
});
it.each(["button","Escape","same row","empty query"])("closes details through %s without changing list scroll",async method=>{
  const {list,row}=await browser();list.scrollTop=123;
  if(method==="empty query")fireEvent.change(screen.getByLabelText("任务编号"),{target:{value:"T1"}});
  fireEvent.click(row("T1"));const card=await screen.findByRole("article",{name:"任务 T1"});
  expect(list.scrollTop).toBe(123);expect(card.classList.contains("tb-card-bounded")).toBe(true);
  if(method==="button")fireEvent.click(screen.getByRole("button",{name:"关闭任务详情"}));
  if(method==="Escape")fireEvent.keyDown(window,{key:"Escape"});
  if(method==="same row")fireEvent.click(row("T1"));
  if(method==="empty query")fireEvent.change(screen.getByLabelText("任务编号"),{target:{value:""}});
  expect(screen.queryByRole("article",{name:"任务 T1"})).toBeNull();expect(list.scrollTop).toBe(123);
  expect(css).toMatch(/\.tb-card-bounded\{[^}]*max-height:var\(--task-detail-max-height,50vh\);overflow:auto/);
});
it("clamps acceptance to four lines and expands on explicit request",async()=>{
  const {row}=await browser();fireEvent.click(row("T1"));const card=await screen.findByRole("article",{name:"任务 T1"});
  const text=card.querySelector(".tb-card-acceptance-text")!;
  expect(text.textContent).toBe(acceptance);expect(text.classList.contains("is-collapsed")).toBe(true);
  expect(css).toMatch(/\.tb-card-acceptance-text.is-collapsed\{[^}]*-webkit-line-clamp:4/);
  fireEvent.click(within(card).getByRole("button",{name:"展开全部"}));expect(text.classList.contains("is-expanded")).toBe(true);
  fireEvent.click(within(card).getByRole("button",{name:"收起"}));expect(text.classList.contains("is-collapsed")).toBe(true);
  fireEvent.click(row("T2"));const next=await screen.findByRole("article",{name:"任务 T2"});
  expect(screen.queryByRole("article",{name:"任务 T1"})).toBeNull();expect(next.querySelector(".is-collapsed")).toBeTruthy();
});
it.each(["button","Escape","same row","empty query"])("rejects late detail completion after cancellation through %s",async method=>{
  const {row}=await browser();let finish!:(value:unknown)=>void;
  bridge.invoke.mockImplementation(async(_command,args)=>args.path.endsWith("/tasks/T1")?new Promise(resolve=>{finish=resolve;}):response(args.path));
  if(method==="empty query")fireEvent.change(screen.getByLabelText("任务编号"),{target:{value:"T1"}});
  fireEvent.click(row("T1"));await waitFor(()=>expect(finish).toBeTypeOf("function"));
  if(method==="button")fireEvent.click(screen.getByRole("button",{name:"关闭任务详情"}));
  if(method==="Escape")fireEvent.keyDown(window,{key:"Escape"});
  if(method==="same row")fireEvent.click(row("T1"));
  if(method==="empty query")fireEvent.change(screen.getByLabelText("任务编号"),{target:{value:""}});
  await act(async()=>{finish(response("/api/v1/projects/demo/tasks/T1"));});
  expect(screen.queryByRole("article")).toBeNull();
});
it("keeps a newer row when the previously clicked row finishes late",async()=>{
  const {row}=await browser();let finish!:(value:unknown)=>void;
  bridge.invoke.mockImplementation(async(_command,args)=>args.path.endsWith("/tasks/T1")?new Promise(resolve=>{finish=resolve;}):response(args.path));
  fireEvent.click(row("T1"));await waitFor(()=>expect(finish).toBeTypeOf("function"));
  fireEvent.click(row("T2"));await screen.findByRole("article",{name:"任务 T2"});
  await act(async()=>{finish(response("/api/v1/projects/demo/tasks/T1"));});
  expect(screen.queryByRole("article",{name:"任务 T1"})).toBeNull();expect(screen.getByRole("article",{name:"任务 T2"})).toBeTruthy();
});

it("sizes detail height from the containing panel and disconnects its observer", async () => {
  let resize!: () => void;
  const disconnect = vi.fn();
  const observe = vi.fn();
  const original = globalThis.ResizeObserver;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  try {
    const view = render(<aside className="workspace-panel"><TaskLookup source={source}/></aside>);
    const panel = view.container.querySelector("aside")!;
    Object.defineProperty(panel, "clientHeight", {value:640, configurable:true});
    act(() => resize());
    expect(observe).toHaveBeenCalledWith(panel);
    expect(screen.getByRole("region", {name:"任务查询"}).style.getPropertyValue("--task-detail-max-height")).toBe("320px");
    Object.defineProperty(panel, "clientHeight", {value:800});
    act(() => resize());
    expect(screen.getByRole("region", {name:"任务查询"}).style.getPropertyValue("--task-detail-max-height")).toBe("400px");
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  } finally {
    vi.stubGlobal("ResizeObserver", original);
  }
});
