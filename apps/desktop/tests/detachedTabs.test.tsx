import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),listeners:new Map<string,(event:any)=>void>(),startDragging:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn(async(name:string,fn:any)=>{mocks.listeners.set(name,fn);return()=>mocks.listeners.delete(name);})}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>({startDragging:mocks.startDragging})}));
vi.mock("../src/components/TerminalView",()=>({default:({session,onStateChange,detachedId}:any)=><div><span>{session.tmux.id}:{session.tmux.created}:{detachedId}</span><button onClick={()=>onStateChange(session.id,"connected")}>连接成功</button><button onClick={()=>onStateChange(session.id,"disconnected")}>连接失败</button></div>}));
vi.mock("../src/components/WebPageView",()=>({default:({page,onStatus}:any)=><button onClick={()=>onStatus("connected")}>{page.target.path??page.target.url}:{page.sessionId}</button>}));
vi.mock("../src/themes",()=>({applyTheme:vi.fn(),getTheme:vi.fn()}));
import DetachedTabWindow,{ReopenedPreview} from "../src/components/DetachedTabWindow";
import {saveDetachedPreviews,loadDetachedPreviews,canDetach,hiddenTab,useDetachedTabs,type DetachedEntry} from "../src/lib/detachedTabs";
import {finishTabDrag} from "../src/lib/tabDetachDrag";
const server={id:"server",name:"Demo",host:"example.test",port:22,username:"demo",authMethod:"password" as const};
const pane={id:"pane",server,tmux:{id:"$3",created:123,name:"work"},tmuxWorkdir:"/workspace/demo"};
const tab={id:"tab",panes:[pane],activePane:0};
const settings={themeId:"dark",fontSize:14,fontFamily:"monospace"};
const entry:DetachedEntry={id:"abc",descriptor:{sourceId:tab.id,kind:"terminal",tab,settings},phase:"opening",error:null};
beforeEach(()=>{mocks.invoke.mockReset();mocks.listeners.clear();mocks.invoke.mockImplementation(async(command:string)=>command==="tab_snapshot"?[structuredClone(entry)]:command==="tab_connect"?"new-ssh":undefined);});
afterEach(cleanup);
describe("detached tab reconnect transaction",()=>{
  it("only permits one-pane tmux tabs, retains the original until child readiness",()=>{
    expect(canDetach(tab)).toBe(true);
    expect(canDetach({...tab,panes:[{id:"plain",server}]})).toBe(false);
    expect(canDetach({...tab,panes:[pane,{...pane,id:"second"}]})).toBe(false);
    expect(hiddenTab([entry],tab.id)).toBe(false);
    expect(hiddenTab([{...entry,phase:"detached"}],tab.id)).toBe(true);
    expect(hiddenTab([{...entry,phase:"returning"}],tab.id)).toBe(false);
  });
  it("child keeps the tmux incarnation and acknowledges only after connection",async()=>{
    render(<DetachedTabWindow id="abc"/>);
    await screen.findByText("$3:123:abc");
    expect(mocks.invoke).not.toHaveBeenCalledWith("tab_ready",expect.anything());
    fireEvent.click(screen.getByText("连接成功"));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("tab_ready",expect.objectContaining({id:"abc"})));
  });
  it("closing a child returns the tab instead of destroying or killing tmux",async()=>{
    mocks.invoke.mockImplementation(async(c:string)=>c==="tab_snapshot"?[{...entry,phase:"detached"}]:undefined);
    render(<DetachedTabWindow id="abc"/>);await screen.findByText("$3:123:abc");
    fireEvent.click(screen.getByLabelText("关闭独立窗口并归还标签"));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("tab_return",{id:"abc"}));
    expect(mocks.invoke.mock.calls.some(([c])=>["tmux_action","ssh_disconnect","local_disconnect"].includes(c))).toBe(false);
  });
  it("failed child attachment reports rollback and never acknowledges removal",async()=>{
    render(<DetachedTabWindow id="abc"/>);await screen.findByText("连接失败");fireEvent.click(screen.getByText("连接失败"));
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("tab_failed",expect.objectContaining({id:"abc"})));
    expect(mocks.invoke.mock.calls.some(([c])=>c==="tab_ready")).toBe(false);
  });
  it("reopens preview using a new connection, releases that connection on unmount",async()=>{
    const onStatus=vi.fn();const page={id:"page",title:"Readme",target:{kind:"markdown" as const,path:"/repo/README.md"},server};
    const view=render(<ReopenedPreview id="abc" page={page} onStatus={onStatus}/>);
    fireEvent.click(await screen.findByText("/repo/README.md:new-ssh"));
    expect(onStatus).toHaveBeenCalledWith("connected");
    expect(mocks.invoke).toHaveBeenCalledWith("tab_connect",{id:"abc",cols:80,rows:24});
    view.unmount();expect(mocks.invoke).toHaveBeenCalledWith("ssh_disconnect",{sessionId:"new-ssh"});
  });
  it("uses native physical coordinates and ignores Escape",async()=>{
    const open=vi.fn();mocks.invoke.mockResolvedValue({outside:true,position:{x:-1400,y:200}});
    await finishTabDrag(true,open);expect(mocks.invoke).not.toHaveBeenCalled();
    await finishTabDrag(false,open);expect(open).toHaveBeenCalledWith({x:-1400,y:200});
    open.mockClear();await finishTabDrag(false,open,"abc");expect(open).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenLastCalledWith("tab_drag_end",{id:"abc"});
  });
  it("main restores the view before acknowledging return and leaves it hidden otherwise",async()=>{
    function Harness(){const state=useDetachedTabs();return <><span>{hiddenTab(state.entries,"tab")?"hidden":"visible"}</span><button onClick={()=>state.state("tab","connected")}>main ready</button></>;}
    render(<Harness/>);await waitFor(()=>expect(mocks.listeners.has("tabs:changed")).toBe(true));
    act(()=>mocks.listeners.get("tabs:changed")?.({payload:[{...entry,phase:"detached"}]}));
    expect(await screen.findByText("hidden")).toBeTruthy();
    act(()=>mocks.listeners.get("tabs:changed")?.({payload:[{...entry,phase:"returning"}]}));
    expect(await screen.findByText("visible")).toBeTruthy();
    fireEvent.click(screen.getByText("main ready"));
    expect(mocks.invoke).toHaveBeenCalledWith("tab_ready",expect.objectContaining({id:"abc"}));
  });
});

it("cold startup restores detached previews as references without SSH handles or key paths",()=>{
  const descriptor={sourceId:"preview",kind:"preview" as const,settings,page:{id:"preview",title:"Readme",target:{kind:"markdown" as const,path:"/repo/README.md"},server:{...server,keyPath:"/private/key"}}};
  saveDetachedPreviews([{...entry,descriptor,phase:"detached"}]);
  const raw=localStorage.getItem("dssh.detached-previews.v1")!;
  expect(raw).not.toContain("/private/key");expect(raw).not.toContain("sessionId");
  expect(loadDetachedPreviews([server])).toEqual([{...descriptor,page:{...descriptor.page,server}}]);
  expect(loadDetachedPreviews([{...server,host:"changed.test"}])).toEqual([]);
  localStorage.clear();
});
