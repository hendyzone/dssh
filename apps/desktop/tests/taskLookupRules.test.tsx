import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeInvoke, NOW } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
  BoardError, boardSource, buildIndex, clearBoardCache, defaultLookupSettings, findTaskCodes, formatAge, inferProject, loadLookupSettings,
  lookupTask, parseQuery, resolveCode, saveLookupSettings, serverOverrideKey, shortName, TASK_LOOKUP_KEY, taskIndex, tmuxOverrideKey,
  type IndexTask,
} from "../src/lib/taskLookup";
import { collaborationKey, emptyProfile, type CollaborationProfile } from "../src/lib/collaboration";
import type { SessionInfo } from "../src/types";

const source = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test:8091/" })!;
const idx = (...codes: string[]): IndexTask[] => codes.map(code => ({ code, title: code, status_key: "doing", assignee: "", updated_at: "" }));

beforeEach(() => { clearBoardCache(); mocks.invoke.mockReset(); mocks.invoke.mockImplementation(fakeInvoke()); });

describe("parseQuery", () => {
  it("accepts a code, 「项目 编号」 and 「项目/编号」", () => {
    expect(parseQuery(" T1090 ")).toEqual({ project: undefined, code: "T1090" });
    expect(parseQuery("smart-table T1090")).toEqual({ project: "smart-table", code: "T1090" });
    expect(parseQuery("amail/AM-42")).toEqual({ project: "amail", code: "AM-42" });
  });
  it("rejects empty, too many parts and unsafe characters", () => {
    for (const bad of ["", "a b c", "T1;rm", "../x"]) expect(() => parseQuery(bad)).toThrow(BoardError);
  });
});

describe("resolveCode", () => {
  const tasks = idx("T1090", "T90", "AM-42", "AM-1090", "DD-RETRY-403-GAP", "T10901");
  it("matches exact codes case-insensitively", () => {
    expect(resolveCode("t1090", tasks).map(t => t.code)).toEqual(["T1090"]);
  });
  it("completes an omitted prefix and lists every candidate", () => {
    expect(resolveCode("42", tasks).map(t => t.code)).toEqual(["AM-42"]);
    expect(resolveCode("1090", tasks).map(t => t.code)).toEqual(["T1090", "AM-1090"]);
    expect(resolveCode("retry-403-gap", tasks).map(t => t.code)).toEqual(["DD-RETRY-403-GAP"]);
  });
  it("never completes inside a number", () => {
    expect(resolveCode("090", tasks)).toEqual([]);
    expect(resolveCode("0", tasks)).toEqual([]);
  });
});

describe("findTaskCodes", () => {
  const set = new Set(["T1090", "AM-42", "DD-RETRY-403-GAP", "T1"]);
  const has = (code: string) => set.has(code);
  const codes = (text: string) => findTaskCodes(text, has).map(m => [m.code, text.slice(m.start, m.end)]);
  it("finds real codes with punctuation and CJK neighbours", () => {
    expect(codes("修复 T1090: 完成，见 AM-42。")).toEqual([["T1090", "T1090"], ["AM-42", "AM-42"]]);
    expect(codes("任务T1090已交付")).toEqual([["T1090", "T1090"]]);
    expect(codes("(DD-RETRY-403-GAP)")).toEqual([["DD-RETRY-403-GAP", "DD-RETRY-403-GAP"]]);
  });
  it("matches separator-aligned parts but not word middles or other case", () => {
    expect(codes("branch fix-T1090-ui")).toEqual([["T1090", "T1090"]]);
    expect(codes("AT1090 T10900 t1090 T1090x")).toEqual([]);
    expect(codes("plain words only")).toEqual([]);
  });
  it("reports columns of the original text", () => {
    expect(findTaskCodes("ab T1 cd", has)).toEqual([{ start: 3, end: 5, code: "T1" }]);
  });
  it("stays fast on long noisy lines", () => {
    const line = "abc-def-ghi ".repeat(2000);
    const started = performance.now();
    for (let i = 0; i < 50; i++) findTaskCodes(line, has);
    expect(performance.now() - started).toBeLessThan(1500);
  });
});

describe("display rules", () => {
  it("shortens assignees like the web board", () => {
    const slugs = ["smart-table", "smart", "amail"];
    expect(shortName("smart-table-cw3d-pi@motern-agent.com", slugs)).toBe("cw3d-pi");
    expect(shortName("Claude Code", slugs)).toBe("Claude Code");
    // Same as the board: the longest slug that fits is stripped.
    expect(shortName("smart-table", slugs)).toBe("table");
    expect(shortName("", slugs)).toBe("");
  });
  it("formats ages", () => {
    expect(formatAge(new Date(NOW - 30_000).toISOString(), NOW)).toBe("不到 1 分钟");
    expect(formatAge(new Date(NOW - 5 * 60000).toISOString(), NOW)).toBe("5 分钟");
    expect(formatAge(new Date(NOW - 3 * 3600000).toISOString(), NOW)).toBe("3 小时");
    expect(formatAge(new Date(NOW - 72 * 3600000).toISOString(), NOW)).toBe("3 天");
    expect(formatAge("", NOW)).toBe("未知");
  });
});

describe("settings, source and project", () => {
  const pane = { id: "p1", server: { id: "srv", name: "协同机1" }, tmux: { id: "$3", created: 100, name: "lead" } } as unknown as SessionInfo;
  const profile = (patch: Partial<CollaborationProfile> = {}): CollaborationProfile => ({
    ...emptyProfile(), enabled: true, taskboardEnabled: true, membersEnabled: true, tmuxId: "$3", tmuxCreated: 100,
    project: "amail", workdir: "/w", taskboardUrl: "http://remote-board:8091", ...patch,
  });
  it("defaults to terminal links on and survives corrupt storage", () => {
    localStorage.setItem(TASK_LOOKUP_KEY, "{oops");
    expect(loadLookupSettings()).toEqual(defaultLookupSettings());
    localStorage.setItem(TASK_LOOKUP_KEY, JSON.stringify({ boardUrl: "ftp://x", lockedProject: "a b", overrides: { "server:x": "ok", bogus: "y", "tmux:a:b": "bad slug" } }));
    expect(loadLookupSettings()).toEqual({ ...defaultLookupSettings(), overrides: { "server:x": "ok" } });
  });
  it("persists the lock and rejects bad URLs", () => {
    saveLookupSettings({ lockedProject: "smart-table" });
    expect(loadLookupSettings().lockedProject).toBe("smart-table");
    expect(() => saveLookupSettings({ boardUrl: "http://u:p@x" })).toThrow();
  });
  it("prefers the desktop URL, else the session's board binding, never guessing", () => {
    const settings = defaultLookupSettings();
    expect(boardSource(settings)).toBeUndefined();
    expect(boardSource(settings, profile(), "ssh-1")?.route).toMatchObject({ kind: "ssh", sessionId: "ssh-1" });
    expect(boardSource(settings, profile({ taskboardEnabled: false }), "ssh-1")).toBeUndefined();
    expect(boardSource(settings, profile(), undefined)).toBeUndefined();
    expect(boardSource({ ...settings, boardUrl: "http://b:1" }, profile(), "ssh-1")?.route).toEqual({ kind: "direct", url: "http://b:1" });
  });
  it("infers project: lock > collaboration > tmux override > server override", () => {
    const settings = defaultLookupSettings();
    const p = profile();
    const profiles = { [collaborationKey("srv", p)]: p };
    expect(inferProject(settings, pane, {})).toBeUndefined();
    expect(inferProject({ ...settings, overrides: { [serverOverrideKey("srv")]: "dssh" } }, pane, {})).toEqual({ project: "dssh", reason: "server" });
    expect(inferProject({ ...settings, overrides: { [serverOverrideKey("srv")]: "dssh", [tmuxOverrideKey("srv", "lead")]: "cw" } }, pane, {})).toEqual({ project: "cw", reason: "tmux" });
    expect(inferProject({ ...settings, overrides: { [tmuxOverrideKey("srv", "lead")]: "cw" } }, pane, profiles)).toEqual({ project: "amail", reason: "collaboration" });
    expect(inferProject({ ...settings, lockedProject: "smart-table" }, pane, profiles)).toEqual({ project: "smart-table", reason: "locked" });
    // Two bindings of the same tmux session with different projects: ambiguous unless verified.
    const q = profile({ workdir: "/other", project: "dssh" });
    const both = { ...profiles, [collaborationKey("srv", q)]: q };
    expect(inferProject(settings, pane, both)).toBeUndefined();
    expect(inferProject(settings, pane, both, q)).toEqual({ project: "dssh", reason: "collaboration" });
  });
});

describe("lookupTask", () => {
  it("locates a code in the current project with prefix completion", async () => {
    const short = await lookupTask(source, "90", "smart-table");
    expect(short.kind === "task" && short.card.task.code).toBe("T90");
    const result = await lookupTask(source, "t1090", "smart-table");
    expect(result.kind).toBe("task");
    if (result.kind !== "task") return;
    expect(result.card.task.title).toContain("击球辅助线");
    expect(result.card.status).toMatchObject({ name: "待人工验收", color: "#f0a868" });
    expect(result.card.dependencies.map(d => [d.code, d.status?.name])).toEqual([["T1091", "已阻塞"], ["T1092", "已完成"]]);
  });
  it("uses an explicit project over the current one", async () => {
    const result = await lookupTask(source, "amail AM-42", "smart-table");
    expect(result.kind === "task" && result.card.project).toBe("amail");
  });
  it("lists candidates when several codes complete", async () => {
    const result = await lookupTask(source, "1090", "smart-table");
    expect(result.kind === "choices" && result.choices.map(c => c.task.code)).toEqual(["T1090", "ST-1090"]);
  });
  it("searches every project by exact code without a project", async () => {
    const result = await lookupTask(source, "t1090");
    expect(result.kind).toBe("choices");
    if (result.kind === "choices") expect(result.choices.map(c => c.project).sort()).toEqual(["amail", "smart-table"]);
    const single = await lookupTask(source, "DD-RETRY-403-GAP");
    expect(single.kind === "task" && single.card.project).toBe("nanoclaw");
  });
  it("distinguishes missing project, missing code and unreachable board", async () => {
    await expect(lookupTask(source, "nope T1")).rejects.toMatchObject({ kind: "project" });
    await expect(lookupTask(source, "smart-table T9999")).rejects.toMatchObject({ kind: "task" });
    await expect(lookupTask(source, "ZZ-1")).rejects.toMatchObject({ kind: "task" });
    clearBoardCache();
    mocks.invoke.mockImplementation(fakeInvoke({ offline: true }));
    await expect(lookupTask(source, "smart-table T1090")).rejects.toMatchObject({ kind: "unreachable" });
  });
  it("caches the code index and only requests the reduced list", async () => {
    const calls: string[] = [];
    mocks.invoke.mockImplementation(fakeInvoke({ calls }));
    const first = await taskIndex(source, "smart-table");
    const second = await taskIndex(source, "smart-table");
    expect(second).toBe(first);
    expect(calls).toEqual(["/api/v1/projects/smart-table/tasks"]);
    expect(mocks.invoke).toHaveBeenCalledWith("taskboard_get", expect.objectContaining({ index: true, route: { kind: "direct", url: "http://board.test:8091" } }));
    expect(buildIndex("x", idx("A-1")).byCode.has("A-1")).toBe(true);
  });
});
