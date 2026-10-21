import OfficeWindow from "../src/components/OfficeWindow";
import {getTheme} from "../src/themes";
import {act,render,renderHook,waitFor} from "@testing-library/react";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {useOfficeSnapshot,useOfficePublisher,useMainWindowVisibility,useOfficePresence,openOfficeWindow,type OfficeEnvelope} from "../src/lib/officeWindowSync";
import type {OfficeSnapshot} from "../src/lib/teamOffice";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn()}));
const snapshot=(themeId="one-light"):OfficeSnapshot=>({version:1,themeId,animationEnabled:true,mailAvailability:"unavailable",projects:[]});
const envelope=(sequence:number,theme="one-light",epoch="native-a"):OfficeEnvelope=>({epoch,sequence,snapshot:snapshot(theme)});
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}};
let handlers:Record<string,(event:{payload:any})=>void>;
let offs:Record<string,ReturnType<typeof vi.fn>>;
beforeEach(()=>{handlers={};offs={};vi.mocked(invoke).mockReset().mockResolvedValue({snapshot:envelope(1),visible:true});vi.mocked(listen).mockReset().mockImplementation(async(name,handler)=>{handlers[name]=handler;offs[name]=vi.fn();return offs[name]});});
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks()});
it("registers both targeted listeners before first pull and receives cached state without polling",async()=>{
  const first=deferred<()=>void>(),second=deferred<()=>void>();
  vi.mocked(listen).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const view=renderHook(()=>useOfficeSnapshot());
  expect(invoke).not.toHaveBeenCalled();
  expect(listen).toHaveBeenCalledWith("office:snapshot",expect.any(Function),{target:{kind:"WebviewWindow",label:"office"}});
  await act(async()=>first.resolve(vi.fn()));
  expect(invoke).not.toHaveBeenCalled();
  expect(listen).toHaveBeenCalledWith("office:visibility",expect.any(Function),{target:{kind:"WebviewWindow",label:"office"}});
  await act(async()=>second.resolve(vi.fn()));
  await waitFor(()=>expect(view.result.current.snapshot).toEqual(snapshot()));
  expect(vi.mocked(invoke).mock.calls.map(([cmd])=>cmd)).toEqual(["office_request_snapshot"]);
});
it("keeps newer broadcasts and visibility when an older initial pull resolves",async()=>{
  const pull=deferred<any>();vi.mocked(invoke).mockReturnValue(pull.promise);
  const view=renderHook(()=>useOfficeSnapshot());await waitFor(()=>expect(invoke).toHaveBeenCalledWith("office_request_snapshot"));
  act(()=>{handlers["office:snapshot"]({payload:envelope(4,"dark")});handlers["office:visibility"]({payload:false})});
  await act(async()=>pull.resolve({snapshot:envelope(1),visible:true}));
  expect(view.result.current.snapshot?.themeId).toBe("dark");expect(view.result.current.visible).toBe(false);
  act(()=>{handlers["office:snapshot"]({payload:envelope(4,"duplicate")});handlers["office:snapshot"]({payload:envelope(3,"stale")});handlers["office:snapshot"]({payload:envelope(5,"foreign","other-process")})});
  expect(view.result.current.snapshot?.themeId).toBe("dark");
  act(()=>handlers["office:snapshot"]({payload:envelope(5,"new")}));expect(view.result.current.snapshot?.themeId).toBe("new");
});
it("unsubscribes registered listeners and ignores pending replies after unmount",async()=>{
  const pull=deferred<any>();vi.mocked(invoke).mockReturnValue(pull.promise);
  const view=renderHook(()=>useOfficeSnapshot());await waitFor(()=>expect(invoke).toHaveBeenCalled());view.unmount();
  expect(offs["office:snapshot"]).toHaveBeenCalledTimes(1);expect(offs["office:visibility"]).toHaveBeenCalledTimes(1);
  await act(async()=>pull.resolve({snapshot:envelope(8),visible:true}));
  expect(vi.mocked(invoke).mock.calls).toHaveLength(1);
});
it("cleans late listener registration and never requests after an early unmount",async()=>{
  const registration=deferred<()=>void>();vi.mocked(listen).mockReturnValue(registration.promise);const off=vi.fn();
  const view=renderHook(()=>useOfficeSnapshot());view.unmount();await act(async()=>registration.resolve(off));
  expect(off).toHaveBeenCalledTimes(1);expect(invoke).not.toHaveBeenCalled();expect(listen).toHaveBeenCalledTimes(1);
});
it("reports sync failure without falling back to SSH or collaboration reads",async()=>{
  vi.mocked(invoke).mockRejectedValue(new Error("unavailable"));const view=renderHook(()=>useOfficeSnapshot());
  await waitFor(()=>expect(view.result.current.error).toContain("unavailable"));
  expect(view.result.current.snapshot).toBeUndefined();expect(vi.mocked(invoke).mock.calls.map(([cmd])=>cmd)).toEqual(["office_request_snapshot"]);
});
it("publishes no snapshots without office presence, deduplicates content and merges changes for 250ms",async()=>{
 vi.useFakeTimers();vi.mocked(invoke).mockResolvedValue(undefined);
 const view=renderHook(({value,exists})=>useOfficePublisher(value,exists),{initialProps:{value:snapshot("first"),exists:false}});
 await act(async()=>{});await act(async()=>vi.advanceTimersByTimeAsync(1000));expect(invoke).not.toHaveBeenCalled();
 view.rerender({value:snapshot("first"),exists:true});await act(async()=>vi.advanceTimersByTimeAsync(249));expect(invoke).not.toHaveBeenCalled();await act(async()=>vi.advanceTimersByTimeAsync(1));expect(invoke).toHaveBeenCalledTimes(1);
 for(let i=0;i<4;i++)view.rerender({value:snapshot("first"),exists:true});await act(async()=>{handlers["office:request"]({payload:null});await vi.advanceTimersByTimeAsync(1000)});expect(invoke).toHaveBeenCalledTimes(1);
 view.rerender({value:snapshot("middle"),exists:true});await act(async()=>vi.advanceTimersByTimeAsync(100));view.rerender({value:snapshot("latest"),exists:true});await act(async()=>vi.advanceTimersByTimeAsync(150));expect(invoke).toHaveBeenCalledTimes(2);expect(invoke).toHaveBeenLastCalledWith("office_publish_snapshot",{snapshot:snapshot("latest")});
});
it("cancels scheduled publication when office closes and sends the current snapshot after reopening",async()=>{
 vi.useFakeTimers();vi.mocked(invoke).mockResolvedValue(undefined);const value=snapshot();const view=renderHook(({exists})=>useOfficePublisher(value,exists),{initialProps:{exists:true}});await act(async()=>{});
 view.rerender({exists:false});await act(async()=>vi.advanceTimersByTimeAsync(500));expect(invoke).not.toHaveBeenCalled();view.rerender({exists:true});await act(async()=>vi.advanceTimersByTimeAsync(250));expect(invoke).toHaveBeenCalledTimes(1);
 view.rerender({exists:false});view.rerender({exists:true});await act(async()=>vi.advanceTimersByTimeAsync(250));expect(invoke).toHaveBeenCalledTimes(2);view.unmount();expect(offs["office:request"]).toHaveBeenCalledTimes(1);
});
it("opens through the fixed native office command",async()=>{await openOfficeWindow();expect(invoke).toHaveBeenCalledWith("open_office_window");});

it("serializes pending writes across publisher remounts and keeps the newest snapshot last",async()=>{
 vi.useFakeTimers();const oldWrite=deferred<any>();vi.mocked(invoke).mockReturnValueOnce(oldWrite.promise).mockResolvedValue(undefined);
 const old=renderHook(()=>useOfficePublisher(snapshot("old"),true));await act(async()=>vi.advanceTimersByTimeAsync(250));expect(invoke).toHaveBeenCalledTimes(1);old.unmount();
 const next=renderHook(()=>useOfficePublisher(snapshot("new"),true));await act(async()=>vi.advanceTimersByTimeAsync(250));expect(invoke).toHaveBeenCalledTimes(1);
 await act(async()=>oldWrite.resolve(undefined));expect(invoke).toHaveBeenLastCalledWith("office_publish_snapshot",{snapshot:snapshot("new")});expect(vi.mocked(invoke).mock.calls.map(([,args]:any)=>args.snapshot.themeId)).toEqual(["old","new"]);next.unmount();
});
it("subscribes main visibility before native query and preserves a newer minimize event",async()=>{
 const query=deferred<any>();vi.mocked(invoke).mockReturnValue(query.promise);const view=renderHook(()=>useMainWindowVisibility());await waitFor(()=>expect(invoke).toHaveBeenCalledWith("office_main_visibility"));
 expect(listen).toHaveBeenCalledWith("office:main-visibility",expect.any(Function),{target:{kind:"WebviewWindow",label:"main"}});
 act(()=>handlers["office:main-visibility"]({payload:false}));await act(async()=>query.resolve(true));expect(view.result.current).toBe(false);
 act(()=>handlers["office:main-visibility"]({payload:true}));expect(view.result.current).toBe(true);view.unmount();expect(offs["office:main-visibility"]).toHaveBeenCalledTimes(1);
});

it("applies real child theme tokens on initial snapshot and subsequent theme broadcasts",async()=>{
 render(<OfficeWindow/>);await waitFor(()=>expect(document.documentElement.style.getPropertyValue("--ui-panel")).toBe(getTheme("one-light").ui.panel));
 act(()=>handlers["office:snapshot"]({payload:envelope(2,"tokyo-night")}));
 expect(document.documentElement.style.getPropertyValue("--ui-panel")).toBe(getTheme("tokyo-night").ui.panel);
 expect(document.documentElement.style.colorScheme).toBe("dark");
 expect(vi.mocked(invoke).mock.calls.map(([cmd])=>cmd)).toEqual(["office_request_snapshot"]);
});

it("subscribes presence before querying and a lifecycle event wins over a stale initial response",async()=>{
 const registration=deferred<()=>void>(),query=deferred<any>();vi.mocked(listen).mockImplementationOnce(async(name,handler)=>{handlers[name]=handler;return registration.promise});vi.mocked(invoke).mockReturnValue(query.promise);const off=vi.fn();
 const view=renderHook(()=>useOfficePresence());expect(view.result.current).toBe(false);expect(invoke).not.toHaveBeenCalled();await act(async()=>registration.resolve(off));expect(invoke).toHaveBeenCalledWith("office_window_exists");
 act(()=>handlers["office:presence"]({payload:true}));await act(async()=>query.resolve(false));expect(view.result.current).toBe(true);act(()=>handlers["office:presence"]({payload:false}));expect(view.result.current).toBe(false);view.unmount();expect(off).toHaveBeenCalledTimes(1);
});
it("main visibility remains false until native state arrives and also follows document hiding",async()=>{
 const query=deferred<any>();vi.mocked(invoke).mockReturnValue(query.promise);const hidden=vi.spyOn(document,"hidden","get").mockReturnValue(false);const view=renderHook(()=>useMainWindowVisibility());expect(view.result.current).toBe(false);await act(async()=>query.resolve(true));expect(view.result.current).toBe(true);
 hidden.mockReturnValue(true);act(()=>document.dispatchEvent(new Event("visibilitychange")));expect(view.result.current).toBe(false);hidden.mockReturnValue(false);act(()=>document.dispatchEvent(new Event("visibilitychange")));expect(view.result.current).toBe(true);
});

it("does not serialize snapshots on renders while office does not exist",async()=>{
 const value=snapshot();const view=renderHook(({input})=>useOfficePublisher(input,false),{initialProps:{input:value}});await act(async()=>{});const stringify=vi.spyOn(JSON,"stringify");
 for(let i=0;i<4;i++)view.rerender({input:{...value}});expect(stringify).not.toHaveBeenCalled();view.unmount();stringify.mockRestore();
});
