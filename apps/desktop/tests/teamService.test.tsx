import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveSessions } from "../src/lib/agentSessions";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  collector: { briefs: {}, statusNames: {}, offline: false, error: "" } as LiveSessions,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));
vi.mock("../src/lib/agentSessions", async importOriginal => ({
  ...await importOriginal<typeof import("../src/lib/agentSessions")>(),
  useAgentSessions: () => bridge.collector,
}));
import TeamMembers from "../src/components/TeamMembers";
import TeamPanel from "../src/components/TeamPanel";
import CollaborationSettings from "../src/components/CollaborationSettings";
import { configureTeamService, subscribeTeamService, useTeamService, refreshServiceAi } from "../src/lib/teamService";
import { emptyProfile } from "../src/lib/collaboration";
import { parseAgentSessions } from "../src/lib/agentSessions";
import type { ServerEntry } from "../src/types";

const server: ServerEntry = { id: "local-test", name: "Example", host: "host-a", port: 22, username: "dev", authMethod: "password" };
const profile = { ...emptyProfile(), project: "demo", enabled: true, membersEnabled: true };
const member = (name = "worker-a", project = "demo") => ({
  key: `${name}@example.invalid`, email: `${name}@example.invalid`, project, role: name,
  host: "host-a", port: 22, username: "dev", workdir: "/srv/project", tmux: { id: "$2", created: 123, name },
});
const snapshot = (seq = 1, names = ["worker-a"], project = "demo") => ({
  type: "snapshot", project, seq, lseq: 0, members: names.map(name => member(name, project)), ai: {}, live: {}, machines: {},
});
let native: { url: string | null; projects: string[]; status: Record<string, unknown>; snapshots: Record<string, unknown> };
let serial = 0;
function Probe() { return <output data-testid="service-state">{JSON.stringify(useTeamService())}</output>; }
function state() { return JSON.parse(screen.getByTestId("service-state").textContent!); }
async function emit(name: string, payload: unknown) {
  await act(async () => { for (const callback of bridge.listeners.get(name) ?? []) callback({ payload }); });
}
async function boot() {
  render(<><Probe/><TeamMembers sessionId="unused" profile={profile} navigation={{ server, servers: [server], onOpen: vi.fn() }}/></>);
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("team_service_read"));
  await act(async () => { await configureTeamService(`https://service-${++serial}.example.invalid`, "test-credential", ["demo"]); });
}
beforeEach(() => {
  localStorage.clear();
  bridge.invoke.mockReset();
  bridge.listen.mockReset();
  bridge.collector = { briefs: {}, statusNames: {}, offline: false, error: "" };
  native = { url: null, projects: [], status: { state: "offline", token_configured: false }, snapshots: {} };
  bridge.listen.mockImplementation(async (name: string, callback: (event: { payload: unknown }) => void) => {
    const callbacks = bridge.listeners.get(name) ?? new Set(); callbacks.add(callback); bridge.listeners.set(name, callbacks);
    return () => { callbacks.delete(callback); };
  });
  bridge.invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "team_service_configure") {
      native = { ...native, url: String(args?.url).replace(/^https:/, "wss:").replace(/^http:/, "ws:").replace(/\/$/, "") + "/team/ws", status: { state: "offline", token_configured: true }, snapshots: {} };
      return native.status;
    }
    if (command === "team_service_subscribe") { native.projects = args?.projects as string[]; return null; }
    if (command === "team_service_read") return structuredClone(native);
    if (command === "team_service_status") return native.status;
    throw new Error(`Unexpected command: ${command}`);
  });
});
afterEach(() => { cleanup(); });

it("renders a service snapshot without a Lead tmux binding or SSH roster request", async () => {
  await boot();
  await emit("team://snapshot", snapshot());
  expect(await screen.findByRole("button", { name: "打开 · worker-a · worker-a" })).toBeTruthy();
  expect(state().snapshots.demo.seq).toBe(1);
  expect(bridge.invoke.mock.calls.every(([name]) => String(name).startsWith("team_service_"))).toBe(true);
  expect(screen.getByText("AI 摘要由团队服务生成")).toBeTruthy();
});

it("applies contiguous deltas and ignores duplicate or older updates", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  await emit("team://delta", { type: "delta", project: "demo", seq: 2, ops: [{ op: "upsert", member: member("worker-b") }] });
  expect(await screen.findByRole("button", { name: "打开 · worker-b · worker-b" })).toBeTruthy();
  for (const seq of [1, 2]) await emit("team://delta", { type: "delta", project: "demo", seq, ops: [{ op: "remove", key: member().key }] });
  expect(state().snapshots.demo.seq).toBe(2);
  expect(screen.getByRole("button", { name: "打开 · worker-a · worker-a" })).toBeTruthy();
  await emit("team://delta", { type: "delta", project: "demo", seq: 3, ops: [{ op: "remove", key: member().key }] });
  expect(screen.queryByRole("button", { name: "打开 · worker-a · worker-a" })).toBeNull();
});

it("does not apply a sequence gap and requests the native authoritative view", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  native.snapshots.demo = snapshot();
  const reads = bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length;
  await emit("team://delta", { type: "delta", project: "demo", seq: 3, ops: [{ op: "remove", key: member().key }] });
  expect(state().snapshots.demo.seq).toBe(1);
  await waitFor(() => expect(bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length).toBeGreaterThan(reads));
  expect(screen.getByRole("button", { name: "打开 · worker-a · worker-a" })).toBeTruthy();
});

it("service live state wins, while no_agent uses the existing collector fallback", async () => {
  bridge.collector.snapshot = parseAgentSessions({ now: Date.now() / 1000, sessions: [{ host: "host-a", session: "worker-a", box: "worker-a", state: "stuck", state_detail: "fallback-probe", host_ok: true, seen_at: Date.now() / 1000, worktree: "/srv/project" }] });
  await boot(); await emit("team://snapshot", snapshot());
  await emit("team://live", { type: "live", project: "demo", lseq: 1, full: true, items: [{ key: member().key, match: "exact", state: "running", stale: false }] });
  expect(screen.queryByText("卡住：fallback-probe")).toBeNull();
  await emit("team://live", { type: "live", project: "demo", lseq: 2, full: false, items: [{ key: member().key, match: "no_agent", state: "unknown", detail: "" }] });
  expect(screen.queryByText("卡住：fallback-probe")).not.toBeNull();
});

it("keeps projects isolated and ignores events outside the subscription", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  await emit("team://snapshot", snapshot(9, ["outsider"], "other"));
  expect(state().snapshots.other).toBeUndefined();
  expect(screen.queryByRole("button", { name: /outsider/ })).toBeNull();
});

it("shows unauthorized state without exposing the configured credential", async () => {
  await boot(); await emit("team://status", { state: "unauthorized", token_configured: true });
  expect(await screen.findByText(/令牌.*失效|失效.*令牌/)).toBeTruthy();
  expect(document.body.textContent).not.toContain("test-credential");
  expect(JSON.stringify(state())).not.toContain("test-credential");
  expect(JSON.stringify(localStorage)).not.toContain("test-credential");
  expect(bridge.invoke.mock.calls.filter(([name]) => name === "team_service_configure")).toHaveLength(1);
});

it("displays the real cached observation time while offline", async () => {
  await boot();
  const savedAt = Date.UTC(2025, 0, 2, 3, 4);
  native.snapshots.demo = { ...snapshot(), savedAt, offline: true };
  await act(async () => { await subscribeTeamService(["demo"]); });
  expect(state().snapshots.demo.receivedAt).toBe(savedAt);
  expect(screen.queryByText(/团队服务离线.*数据截至 03:04/)).not.toBeNull();
});

it("does not invent a current observation time for an old cache without a timestamp", async () => {
  await boot();
  native.snapshots.demo = { ...snapshot(), savedAt: null, offline: true };
  await act(async () => { await subscribeTeamService(["demo"]); });
  expect(state().snapshots.demo.receivedAt).toBeNull();
  expect(await screen.findByText(/团队服务离线.*数据时间未知/)).toBeTruthy();
});

it("registers every event listener before the initial native snapshot read", async () => {
  await boot();
  const firstRead = bridge.invoke.mock.calls.findIndex(([command]) => command === "team_service_read");
  const readOrder = bridge.invoke.mock.invocationCallOrder[firstRead];
  expect(bridge.listen.mock.calls.slice(0, 4).map(([name]) => name).sort()).toEqual(["team://delta", "team://live", "team://snapshot", "team://status"]);
  expect(bridge.listen.mock.invocationCallOrder.slice(0, 4).every(order => order < readOrder)).toBe(true);
});

it("does not let a delayed native read replace a newer event snapshot", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  const original = bridge.invoke.getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  const pending = new Promise(value => { resolve = value; });
  bridge.invoke.mockImplementation((command, args) => command === "team_service_read" ? pending : original(command, args));
  const reads = bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length;
  let updating!: Promise<void>;
  await act(async () => { updating = subscribeTeamService(["demo"]); });
  await waitFor(() => expect(bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length).toBeGreaterThan(reads));
  await emit("team://snapshot", snapshot(8, ["worker-new"]));
  await act(async () => { resolve({ ...native, snapshots: { demo: snapshot(1) } }); await updating; });
  expect(state().snapshots.demo.seq).toBe(8);
  expect(screen.getByRole("button", { name: "打开 · worker-new · worker-new" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "打开 · worker-a · worker-a" })).toBeNull();
});

it("separates identical project names when the configured service URL changes", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  const first = state().snapshots.demo.identity;
  await act(async () => { await configureTeamService("https://other-service.example.invalid", "replacement-credential", ["demo"]); });
  expect(state().snapshots.demo).toBeUndefined();
  expect(screen.queryByRole("button", { name: "打开 · worker-a · worker-a" })).toBeNull();
  await emit("team://snapshot", snapshot(1, ["worker-new"]));
  expect(state().snapshots.demo.identity).not.toBe(first);
  expect(state().snapshots.demo.identity).toContain("other-service.example.invalid");
});

it("applies ordered live maps and global machine events without persisting volatile state", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  const item = { key: member().key, match: "exact", state: "running", detail: "", stale: false };
  await emit("team://live", { type: "live", project: "demo", lseq: 2, full: true, items: [item] });
  await emit("team://live", { type: "live", project: "demo", lseq: 1, full: true, items: [] });
  expect(state().snapshots.demo.live[member().key].state).toBe("running");
  await emit("team://live", { type: "machine", name: "host-a", online: false, seen: null, version: "1.0.0" });
  expect(state().snapshots.demo.machines["host-a"].online).toBe(false);
  await emit("team://live", { type: "live", project: "demo", lseq: 3, full: true, items: [] });
  expect(state().snapshots.demo.live).toEqual({});
  for (let i = 0; i < localStorage.length; i++) {
    const value = localStorage.getItem(localStorage.key(i)!)!;
    expect(value).not.toContain('"lseq"'); expect(value).not.toContain('"machines"'); expect(value).not.toContain('"live"');
  }
});

it("releases event listeners after the last real component unmounts", async () => {
  await boot();
  expect([...bridge.listeners.values()].reduce((sum, values) => sum + values.size, 0)).toBe(4);
  cleanup();
  expect([...bridge.listeners.values()].reduce((sum, values) => sum + values.size, 0)).toBe(0);
});

it("submits a settings token once then clears the input and stores only configuration", async () => {
  render(<><Probe/><CollaborationSettings/></>);
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("team_service_read"));
  fireEvent.change(screen.getByLabelText("团队服务地址"), { target: { value: "https://settings-service.example.invalid" } });
  fireEvent.change(screen.getByLabelText("团队服务令牌"), { target: { value: "settings-secret-value" } });
  fireEvent.change(screen.getByLabelText("订阅项目"), { target: { value: "demo, another" } });
  fireEvent.click(screen.getByRole("button", { name: "保存团队服务" }));
  await screen.findByText("团队服务已配置。");
  expect((screen.getByLabelText("团队服务令牌") as HTMLInputElement).value).toBe("");
  expect(screen.getByText("令牌：已配置")).toBeTruthy();
  const calls = bridge.invoke.mock.calls.filter(([name]) => name === "team_service_configure");
  expect(calls).toHaveLength(1); expect(calls[0][1]).toMatchObject({ token: "settings-secret-value" });
  expect(JSON.stringify(state())).not.toContain("settings-secret-value");
  expect(JSON.stringify(localStorage)).not.toContain("settings-secret-value");
});

it("retains a new machine event when an earlier native read completes", async () => {
  await boot(); await emit("team://snapshot", snapshot());
  const original = bridge.invoke.getMockImplementation()!;
  let resolve!: (value: unknown) => void;
  const pending = new Promise(value => { resolve = value; });
  let first = true;
  bridge.invoke.mockImplementation((command, args) => {
    if (command === "team_service_read" && first) { first = false; return pending; }
    return original(command, args);
  });
  const reads = bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length;
  let updating!: Promise<void>;
  await act(async () => { updating = subscribeTeamService(["demo"]); });
  await waitFor(() => expect(bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length).toBeGreaterThan(reads));
  await emit("team://live", { type: "machine", name: "host-a", online: false, seen: null, version: "1.0.0" });
  native.snapshots.demo = { ...snapshot(), machines: { "host-a": { name: "host-a", online: false, seen: null, version: "1.0.0" } } };
  await act(async () => { resolve({ ...native, snapshots: { demo: snapshot() } }); await updating; });
  await waitFor(() => expect(bridge.invoke.mock.calls.filter(([name]) => name === "team_service_read").length).toBeGreaterThan(reads + 1));
  expect(state().snapshots.demo.machines["host-a"]?.online).toBe(false);
});

it("restores a lower authoritative replacement missed while all views were unmounted", async () => {
  await boot(); await emit("team://snapshot", snapshot(9, ["worker-old"]));
  cleanup();
  native.snapshots.demo = snapshot(2, ["worker-new"]);
  render(<><Probe/><TeamMembers sessionId="other-pane" profile={profile} navigation={{ server, servers: [server], onOpen: vi.fn() }}/></>);
  await screen.findByRole("button", { name: "打开 · worker-new · worker-new" });
  expect(state().snapshots.demo.seq).toBe(2);
  expect(screen.queryByRole("button", { name: "打开 · worker-old · worker-old" })).toBeNull();
});

it("opens a real team panel without a Lead profile or tmux binding and switches service projects", async () => {
  render(<><Probe/><TeamPanel sessionId="" pane={{ id: "unbound-pane", server }} navigation={{ server, servers: [server], onOpen: vi.fn() }} onClose={vi.fn()}/></>);
  await waitFor(() => expect(bridge.invoke).toHaveBeenCalledWith("team_service_read"));
  await act(async () => { await configureTeamService("https://panel-service.example.invalid", "panel-credential", ["demo", "another"]); });
  await emit("team://snapshot", snapshot());
  await emit("team://snapshot", snapshot(1, ["other-worker"], "another"));
  expect(await screen.findByRole("button", { name: "打开 · worker-a · worker-a" })).toBeTruthy();
  expect(screen.getByText("团队 · demo")).toBeTruthy();
  expect(screen.queryByText("将当前窗口设为 Lead")).toBeNull();
  fireEvent.change(screen.getByLabelText("团队项目"), { target: { value: "another" } });
  expect(await screen.findByRole("button", { name: "打开 · other-worker · other-worker" })).toBeTruthy();
  expect(screen.getByText("团队 · another")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "打开 · worker-a · worker-a" })).toBeNull();
});

it("keeps service AI until a real AI delta arrives after refresh", async () => {
  await boot();
  const ai={status:"working",summary:"Initial service summary",evidence:"literal evidence",model:"example-model",updatedAt:new Date().toISOString()};
  await emit("team://snapshot", {...snapshot(),ai:{[member().key]:ai}});
  expect(screen.getAllByText(ai.summary).length).toBeGreaterThan(0);
  const previous=bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async(command,args)=>command==="team_service_ai_refresh"?{status:202,code:"accepted"}:previous(command,args));
  await act(async()=>{fireEvent.click(screen.getAllByRole("button",{name:"重新总结",hidden:true})[0]);});
  expect(screen.getByText("已请求，等待服务更新")).toBeTruthy();
  expect(state().snapshots.demo.ai[member().key].summary).toBe(ai.summary);
  await emit("team://delta",{type:"delta",project:"demo",seq:2,ops:[{op:"ai",key:member().key,ai:{...ai,summary:"Updated by service"}}]});
  expect(screen.getAllByText("Updated by service").length).toBeGreaterThan(0);
  expect(screen.queryByText(ai.summary)).toBeNull();
  expect(bridge.invoke).toHaveBeenCalledWith("team_service_ai_refresh",{project:"demo",key:member().key});
});

it("uses only the safe capability boolean and shows disabled service AI", async () => {
  const original=bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async(command,args)=>command==="team_service_capabilities"?{ai_enabled:false}:original(command,args));
  await boot(); await emit("team://snapshot",snapshot());
  expect(state().status.ai_enabled).toBe(false);
  expect(screen.getAllByText("AI 摘要未启用").length).toBeGreaterThan(0);
  for(const button of screen.getAllByRole("button",{name:"重新总结",hidden:true}))expect((button as HTMLButtonElement).disabled).toBe(true);
  await emit("team://status",{state:"online",token_configured:true});
  expect(state().status.ai_enabled).toBe(false);
});

it("discards a capability response from the previous configured service", async () => {
  await boot();
  const original=bridge.invoke.getMockImplementation()!;
  let finish!:(value:unknown)=>void;let count=0;
  bridge.invoke.mockImplementation(async(command,args)=>{
    if(command==="team_service_capabilities") { count++;return count===1?new Promise(resolve=>{finish=resolve;}):{ai_enabled:true}; }
    return original(command,args);
  });
  let first!:Promise<void>;
  await act(async()=>{first=configureTeamService("https://old.example.invalid","test-credential",["demo"]);await Promise.resolve();await Promise.resolve();});
  await waitFor(()=>expect(finish).toBeTypeOf("function"));
  await act(async()=>configureTeamService("https://new.example.invalid","test-credential",["demo"]));
  await act(async()=>{finish({ai_enabled:false});await first;});
  expect(state().url).toContain("new.example.invalid");expect(state().status.ai_enabled).toBe(true);
});

it("propagates ai_disabled refresh to all service AI views", async () => {
  await boot(); await emit("team://snapshot",snapshot());
  const original=bridge.invoke.getMockImplementation()!;
  bridge.invoke.mockImplementation(async(command,args)=>command==="team_service_ai_refresh"?{status:503,code:"ai_disabled"}:original(command,args));
  await act(async()=>fireEvent.click(screen.getAllByRole("button",{name:"重新总结",hidden:true})[0]));
  expect(state().status.ai_enabled).toBe(false);
  expect(screen.getAllByText("AI 摘要未启用")).toHaveLength(2);
  expect((screen.getByRole("button",{name:"重新总结",hidden:true}) as HTMLButtonElement).disabled).toBe(true);
});

it("does not let an earlier capability read undo a newer ai_disabled response", async () => {
  await boot();
  const original=bridge.invoke.getMockImplementation()!;
  let finish!:(value:unknown)=>void;
  bridge.invoke.mockImplementation(async(command,args)=>{
    if(command==="team_service_capabilities")return new Promise(resolve=>{finish=resolve;});
    if(command==="team_service_ai_refresh")return {status:503,code:"ai_disabled"};
    return original(command,args);
  });
  let config!:Promise<void>;
  await act(async()=>{config=configureTeamService("https://capability.example.invalid","test-credential",["demo"]);await Promise.resolve();await Promise.resolve();});
  await waitFor(()=>expect(finish).toBeTypeOf("function"));
  await act(async()=>{await refreshServiceAi("demo",member().key);});
  expect(state().status.ai_enabled).toBe(false);
  await act(async()=>{finish({ai_enabled:true});await config;});
  expect(state().status.ai_enabled).toBe(false);
});
