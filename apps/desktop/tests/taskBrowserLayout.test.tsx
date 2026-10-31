import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
const css = readFileSync(`${process.cwd()}/src/components/TaskLookup.css`, "utf8");
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
import TaskLookup from "../src/components/TaskLookup";
import TaskCard from "../src/components/TaskCard";
import { boardSource, clearBoardCache, defaultLookupSettings, loadCard } from "../src/lib/taskLookup";
const source = boardSource({ ...defaultLookupSettings(), boardUrl: "https://board.example.invalid" })!;
const acceptance = Array.from({length:8}, (_, i) => `验收步骤 ${i + 1}`).join("\n");
const task = (code: string) => ({code,title:`${code} a long title that should stay on one line`,assignee:"example-worker-with-long-name@example.invalid",status_key:"doing",updated_at:"2026-01-01T00:00:00Z",status_changed_at:"2026-01-01T00:00:00Z",summary:"Summary",acceptance,detail:"Details"});
const response = (path: string) => ({status:200,body:JSON.stringify(
  path === "/api/v1/projects" ? {projects:[{slug:"demo",name:"Demo",archived:false}]} :
  path.endsWith("/statuses") ? {statuses:[{key:"doing",name:"进行中"}]} :
  path.endsWith("/dependencies") ? {dependencies:[]} :
  path.endsWith("/tasks") ? {tasks:[task("T1"),task("T2")]} : task(path.split("/").at(-1)!)
)});
const openDetail = vi.fn();
beforeEach(() => { localStorage.clear();clearBoardCache();openDetail.mockReset();bridge.invoke.mockReset();bridge.invoke.mockImplementation(async (_command,args) => response(args.path)); });
async function browser() {
  render(<TaskLookup source={source} inferred={{project:"demo",reason:"team"}} onOpenTaskDetail={openDetail}/>);
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
it("routes browse-list clicks through the overlay opener without embedding a card", async () => {
  const {list,row}=await browser();list.scrollTop=123;
  fireEvent.click(row("T1"));
  await waitFor(() => expect(openDetail).toHaveBeenCalledWith("demo","T1"));
  expect(list.scrollTop).toBe(123);
  expect(screen.queryByRole("article",{name:"任务 T1"})).toBeNull();
  expect(document.querySelector(".task-lookup-outcome .tb-card")).toBeNull();
});
it("clamps acceptance to four lines and expands on explicit request",async()=>{
  const card=await loadCard(source,"demo","T1");
  render(<TaskCard card={card} source={source}/>);
  const text=screen.getByRole("article").querySelector(".tb-card-acceptance-text")!;
  expect(text.textContent).toBe(acceptance);expect(text.classList.contains("is-collapsed")).toBe(true);
  expect(css).toMatch(/\.tb-card-acceptance-text.is-collapsed\{[^}]*-webkit-line-clamp:4/);
  fireEvent.click(within(screen.getByRole("article")).getByRole("button",{name:"展开全部"}));expect(text.classList.contains("is-expanded")).toBe(true);
  fireEvent.click(within(screen.getByRole("article")).getByRole("button",{name:"收起"}));expect(text.classList.contains("is-collapsed")).toBe(true);
});
