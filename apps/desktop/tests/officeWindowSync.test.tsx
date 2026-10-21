import OfficeWindow from "../src/components/OfficeWindow";
import {getTheme} from "../src/themes";
import {act,render,renderHook,waitFor} from "@testing-library/react";
import {beforeEach,afterEach,expect,it,vi} from "vitest";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {useOfficeSnapshot,useOfficePublisher,useMainWindowVisibility,openOfficeWindow,type OfficeEnvelope} from "../src/lib/officeWindowSync";
import type {OfficeSnapshot} from "../src/lib/teamOffice";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn()}));
vi.mock("@tauri-apps/api/event",()=>({listen:vi.fn()}));
const snapshot=(themeId="one-light"):OfficeSnapshot=>({version:1,themeId,animationEnabled:true,mailAvailability:"unavailable",projects:[]});
const envelope=(sequence:number,theme="one-light",epoch="native-a"):OfficeEnvelope=>({epoch,sequence,snapshot:snapshot(theme)});
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return {promise,resolve}};
let handlers:Record<string,(event:{payload:any})=>void>;
let offs:Record<string,ReturnType<typeof vi.fn>>;
beforeEach(()=>{handlers={};offs={};vi.mocked(invoke).mockReset().mockResolvedValue({snapshot:envelope(1),visible:true});vi.mocked(listen).mockReset().mockImplementation(async(name,handler)=>{handlers[name]=handler;offs[name]=vi.fn();return offs[name]});});
afterEach(()=>vi.restoreAllMocks());
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
it("republishes latest state on child request and serializes updates",async()=>{
  const pending=deferred<any>();vi.mocked(invoke).mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
  const view=renderHook(({value})=>useOfficePublisher(value),{initialProps:{value:snapshot("first")}});
  await waitFor(()=>expect(handlers["office:request"]).toBeTruthy());
  view.rerender({value:snapshot("latest")});
  expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>pending.resolve(undefined));
  await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith("office_publish_snapshot",{snapshot:snapshot("latest")}));
  const before=vi.mocked(invoke).mock.calls.length;
  await act(async()=>handlers["office:request"]({payload:null}));
  expect(invoke).toHaveBeenCalledTimes(before+1);expect(invoke).toHaveBeenLastCalledWith("office_publish_snapshot",{snapshot:snapshot("latest")});
  view.unmount();expect(offs["office:request"]).toHaveBeenCalledTimes(1);
});
it("opens through the fixed native office command",async()=>{await openOfficeWindow();expect(invoke).toHaveBeenCalledWith("open_office_window");});

it("serializes publisher invocations across unmount and remount so an old pending write cannot win",async()=>{
  const oldWrite=deferred<any>();vi.mocked(invoke).mockReturnValueOnce(oldWrite.promise).mockResolvedValue(undefined);
  const old=renderHook(()=>useOfficePublisher(snapshot("old")));await waitFor(()=>expect(invoke).toHaveBeenCalledTimes(1));old.unmount();
  const next=renderHook(()=>useOfficePublisher(snapshot("new")));await act(async()=>{});expect(invoke).toHaveBeenCalledTimes(1);
  await act(async()=>oldWrite.resolve(undefined));await waitFor(()=>expect(invoke).toHaveBeenLastCalledWith("office_publish_snapshot",{snapshot:snapshot("new")}));
  const writes=vi.mocked(invoke).mock.calls.map(([,args]:any)=>args.snapshot.themeId);expect(writes[0]).toBe("old");expect(writes.length).toBeGreaterThanOrEqual(2);expect(writes.slice(1).every(theme=>theme==="new")).toBe(true);next.unmount();
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
