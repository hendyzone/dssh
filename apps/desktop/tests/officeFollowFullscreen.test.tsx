import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import OfficeWindow from "../src/components/OfficeWindow";
import TeamOffice from "../src/components/TeamOffice";
import type { OfficeSnapshot } from "../src/lib/teamOffice";
const bridge=vi.hoisted(()=>({invoke:vi.fn(),listen:vi.fn(),isFullscreen:vi.fn(),setFullscreen:vi.fn(),onResized:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:bridge.invoke}));
vi.mock("@tauri-apps/api/event",()=>({listen:bridge.listen}));
vi.mock("@tauri-apps/api/window",()=>({getCurrentWindow:()=>({isFullscreen:bridge.isFullscreen,setFullscreen:bridge.setFullscreen,onResized:bridge.onResized})}));
const snapshot=(activeProject?:string):OfficeSnapshot=>({version:1,themeId:"one-light",animationEnabled:false,mailAvailability:"unavailable",activeProject,projects:["alpha","beta"].map(id=>({id,name:id,sources:[{id:id+"-source",label:id,availability:"ready",notice:"",members:[]}]}))});
const envelope=(sequence=1,activeProject="beta")=>({epoch:"fixture",sequence,snapshot:snapshot(activeProject)});
let listeners:Record<string,(event:{payload:any})=>void>;
let resized:()=>void;
let fullscreen=false;
let scroll:ReturnType<typeof vi.fn>;
const originalScroll=HTMLElement.prototype.scrollTo;
beforeEach(()=>{
 localStorage.clear();listeners={};fullscreen=false;scroll=vi.fn();HTMLElement.prototype.scrollTo=scroll;
 bridge.invoke.mockReset().mockResolvedValue({visible:true,snapshot:envelope()});
 bridge.listen.mockReset().mockImplementation(async(name,callback)=>{listeners[name]=callback;return vi.fn();});
 bridge.isFullscreen.mockReset().mockImplementation(async()=>fullscreen);
 bridge.setFullscreen.mockReset().mockImplementation(async(value)=>{fullscreen=value;});
 bridge.onResized.mockReset().mockImplementation(async(callback)=>{resized=callback;return vi.fn();});
});
afterEach(()=>{vi.restoreAllMocks();HTMLElement.prototype.scrollTo=originalScroll;localStorage.clear();});
const root=()=>screen.getByRole("region",{name:"公司办公室"});
const collapsed=(project:string)=>screen.getByRole("region",{name:`项目 ${project}`}).querySelector(".office-project-floor")!.hasAttribute("hidden");
it("follows only a known active project, persists opt-out, and keeps unknown focus from switching projects",()=>{
 const view=render(<TeamOffice snapshot={snapshot("beta")}/>);
 expect(collapsed("alpha")).toBe(true);expect(collapsed("beta")).toBe(false);expect(scroll).toHaveBeenCalled();
 view.rerender(<TeamOffice snapshot={snapshot("alpha")}/>);expect(collapsed("alpha")).toBe(false);expect(collapsed("beta")).toBe(true);
 view.rerender(<TeamOffice snapshot={snapshot("not-present")}/>);expect(collapsed("alpha")).toBe(false);expect(collapsed("beta")).toBe(true);
 fireEvent.click(screen.getByRole("checkbox",{name:"跟随当前窗口"}));
 expect(root().getAttribute("data-follow")).toBe("false");expect(localStorage.getItem("dssh.office.follow.v1")).toBe("false");
 view.rerender(<TeamOffice snapshot={snapshot("beta")}/>);expect(collapsed("alpha")).toBe(false);expect(collapsed("beta")).toBe(true);
 view.unmount();render(<TeamOffice snapshot={snapshot("beta")}/>);expect(root().getAttribute("data-follow")).toBe("false");
});
it("does not fail when follow preference storage is unavailable",()=>{
 vi.spyOn(Storage.prototype,"getItem").mockImplementation(()=>{throw Error("Unavailable");});vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw Error("Unavailable");});
 render(<TeamOffice snapshot={snapshot("beta")}/>);expect(root().getAttribute("data-follow")).toBe("true");
 fireEvent.click(screen.getByRole("checkbox",{name:"跟随当前窗口"}));expect(root().getAttribute("data-follow")).toBe("false");
});
it("passes the native snapshot's project string through the real sync hook without credentials",async()=>{
 render(<OfficeWindow/>);await screen.findByRole("region",{name:"项目 beta"});
 expect(collapsed("beta")).toBe(false);expect(collapsed("alpha")).toBe(true);
 act(()=>listeners["office:snapshot"]({payload:envelope(2,"alpha")}));expect(collapsed("alpha")).toBe(false);
 expect(bridge.invoke.mock.calls.map(([command])=>command)).toEqual(["office_request_snapshot"]);
 expect(JSON.stringify(bridge.invoke.mock.calls)).not.toMatch(/token|password|host-a/);
});
it("uses the native fullscreen API for F11 and Esc and reveals the header only in the top 8px",async()=>{
 render(<OfficeWindow/>);await screen.findByRole("region",{name:"公司办公室"});
 fireEvent.keyDown(window,{key:"F11"});await waitFor(()=>expect(bridge.setFullscreen).toHaveBeenCalledWith(true));
 await waitFor(()=>expect(root().getAttribute("data-fullscreen")).toBe("true"));expect(root().getAttribute("data-top-hidden")).toBe("true");
 fireEvent.mouseMove(root(),{clientY:8});expect(root().getAttribute("data-top-hidden")).toBe("true");
 fireEvent.mouseMove(root(),{clientY:7});expect(root().getAttribute("data-top-hidden")).toBe("false");
 fireEvent.keyDown(window,{key:"Escape"});await waitFor(()=>expect(bridge.setFullscreen).toHaveBeenCalledWith(false));
 await waitFor(()=>expect(root().getAttribute("data-fullscreen")).toBe("false"));expect(root().getAttribute("data-top-hidden")).toBe("false");
});
it("does not claim fullscreen on API failure and can retry through the button",async()=>{
 bridge.setFullscreen.mockRejectedValueOnce(new Error("Native failed with private text"));render(<OfficeWindow/>);await screen.findByRole("region",{name:"公司办公室"});
 fireEvent.click(screen.getByRole("button",{name:"全屏"}));await screen.findByRole("alert");expect(root().getAttribute("data-fullscreen")).toBe("false");expect(root().getAttribute("data-top-hidden")).toBe("false");
 expect(screen.getByRole("alert").textContent).not.toContain("private text");fireEvent.click(screen.getByRole("button",{name:"全屏"}));await waitFor(()=>expect(root().getAttribute("data-fullscreen")).toBe("true"));
});
it("supports hiding the top outside fullscreen without calling the native fullscreen API",async()=>{
 render(<OfficeWindow/>);await screen.findByRole("region",{name:"公司办公室"});
 fireEvent.click(screen.getByRole("button",{name:"隐藏顶部"}));expect(root().getAttribute("data-top-hidden")).toBe("true");expect(bridge.setFullscreen).not.toHaveBeenCalled();
 fireEvent.mouseMove(root(),{clientY:3});expect(root().getAttribute("data-top-hidden")).toBe("false");
});

const deferred=<T,>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return{promise,resolve};};
it("keeps newer resize state over late initial read and cleans up native listeners",async()=>{
 const initial=deferred<boolean>();const off=vi.fn();bridge.isFullscreen.mockReturnValueOnce(initial.promise).mockResolvedValue(true);
 bridge.onResized.mockImplementation(async(callback)=>{resized=callback;return off;});
 const view=render(<OfficeWindow/>);await screen.findByRole("region",{name:"公司办公室"});await waitFor(()=>expect(bridge.isFullscreen).toHaveBeenCalledTimes(1));
 act(()=>resized());await waitFor(()=>expect(root().getAttribute("data-fullscreen")).toBe("true"));
 await act(async()=>initial.resolve(false));expect(root().getAttribute("data-fullscreen")).toBe("true");
 view.unmount();expect(off).toHaveBeenCalledTimes(1);fireEvent.keyDown(window,{key:"F11"});expect(bridge.setFullscreen).not.toHaveBeenCalled();
});
it("ignores repeated F11 and overlapping native changes",async()=>{
 const pending=deferred<void>();bridge.setFullscreen.mockReturnValueOnce(pending.promise);
 render(<OfficeWindow/>);await screen.findByRole("region",{name:"公司办公室"});
 fireEvent.keyDown(window,{key:"F11",repeat:true});expect(bridge.setFullscreen).not.toHaveBeenCalled();
 fireEvent.keyDown(window,{key:"F11"});fireEvent.keyDown(window,{key:"F11"});expect(bridge.setFullscreen).toHaveBeenCalledTimes(1);
 fullscreen=true;await act(async()=>pending.resolve());expect(root().getAttribute("data-fullscreen")).toBe("true");
});
