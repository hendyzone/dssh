import { act, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { ILink, ILinkProvider } from "ghostty-web";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({
  init: vi.fn(), invoke: vi.fn(), listen: vi.fn(), instances: [] as any[],
  listeners: new Map<string, (event: { payload: any }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({ default: "test.wasm" }));

/** Match ghostty's buffer cells, including the spacer after a wide character. */
function row(text: string) {
  const cells: { codepoint: number; width: number }[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const width = cp > 0x2e80 ? 2 : 1;
    cells.push({ codepoint: cp, width });
    if (width === 2) cells.push({ codepoint: 0, width: 0 });
  }
  return {
    length: cells.length, isWrapped: false,
    getCell: (x: number) => x < cells.length
      ? { getCodepoint: () => cells[x].codepoint, getWidth: () => cells[x].width, getHyperlinkId: () => 0 }
      : undefined,
  };
}

vi.mock("ghostty-web", async () => {
  // Use the real detector: earlier registered providers win at overlapping cells.
  // Selecting the path provider directly would hide a broken registration order.
  const { LinkDetector } = await import("../../../vendor/ghostty-web/lib/link-detector");
  return {
    init: mocks.init,
    FitAddon: class { observeResize() {} fit() {} },
    Terminal: class {
      options: any; root?: HTMLElement; providers: ILinkProvider[] = []; lines: string[] = [];
      cols = 80; rows = 24;
      buffer = { active: { getLine: (y: number) => this.lines[y] === undefined ? undefined : row(this.lines[y]) } };
      detector = new LinkDetector(this);
      constructor(options: any) { this.options = options; mocks.instances.push(this); }
      loadAddon() {}
      open(root: HTMLElement) { this.root = root; root.innerHTML = "<textarea></textarea><canvas></canvas>"; }
      focus() {}
      write = vi.fn(() => this.detector.invalidateCache());
      scrollToBottom = vi.fn(); getSelection = vi.fn(() => "");
      hasMouseTracking = vi.fn(() => false); selectAll = vi.fn();
      registerLinkProvider(provider: ILinkProvider) {
        this.providers.push(provider);
        this.detector.registerProvider(provider);
      }
      attachCustomKeyEventHandler() {}
      onData() { return { dispose() {} }; }
      onResize() { return { dispose() {} }; }
      onRender() { return { dispose() {} }; }
      dispose() { this.detector.dispose(); }
    },
  };
});

import TerminalView from "../src/components/TerminalView";
import { LOCAL_SHELL } from "../src/lib/localShell";
import { boardSource, clearBoardCache, defaultLookupSettings } from "../src/lib/taskLookup";

const source = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test" })!;
const props = {
  session: {
    id: "pane",
    server: { id: "server", name: "server", host: "example.com", port: 22, username: "user", authMethod: "password" as const },
  },
  active: true, inputEnabled: true,
  settings: { themeId: "tokyo-night", fontSize: 14, fontFamily: "monospace" },
  onBackendReady: vi.fn(),
};

beforeEach(() => {
  clearBoardCache();
  mocks.instances.length = 0;
  mocks.listeners.clear();
  mocks.init.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async (name: string, callback: (event: { payload: any }) => void) => {
    mocks.listeners.set(name, callback);
    return () => { mocks.listeners.delete(name); };
  });
  const board = fakeInvoke();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: any) => {
    if (command === "ssh_connect") return "backend";
    if (command === "local_connect") return "local-backend";
    return board(command, args);
  });
});

async function mount(overrides: Partial<ComponentProps<typeof TerminalView>> = {}) {
  const openPage = vi.fn();
  const onStateChange = vi.fn();
  const view = render(<TerminalView {...props} onOpenPage={openPage} onStateChange={onStateChange} {...overrides}/>);
  await waitFor(() => expect(onStateChange).toHaveBeenCalledWith(overrides.session?.id ?? props.session.id, "connected"));
  return { ...view, term: mocks.instances[0], openPage };
}

function setLine(term: any, text: string) {
  term.lines = [text];
  term.detector.invalidateCache();
}

function columnOf(text: string, token: string) {
  const offset = text.indexOf(token);
  expect(offset).toBeGreaterThanOrEqual(0);
  return row(text.slice(0, offset)).length;
}

async function linkAt(term: any, column: number): Promise<ILink | undefined> {
  return term.detector.getLinkAt(column, 0);
}

async function activate(link: ILink | undefined, init: MouseEventInit = { button: 0 }) {
  expect(link).toBeDefined();
  await act(async () => { link!.activate(new MouseEvent("click", init)); });
}

async function reportCwd(cwd: string) {
  const listener = mocks.listeners.get("ssh://backend/data");
  expect(listener).toBeDefined();
  const command = mocks.invoke.mock.calls.find(([name]) => name === "ssh_write")?.[1].data as string;
  const marker = command.match(/dssh-init-[a-f0-9-]+/)![0];
  await act(async () => {
    listener!({ payload: `\x1b]1337;${marker}\x07\x1b]7;file://example.com${encodeURI(cwd)}\x07` });
  });
}

it.each([
  ["/tmp/chart.png", "image"],
  ["/tmp/notes.md", "markdown"],
  ["/tmp/preview.html", "html"],
])("opens the absolute path %s through TerminalView's registered provider", async (path, kind) => {
  const { term, openPage } = await mount();
  const text = `result: ${path}`;
  setLine(term, text);
  await activate(await linkAt(term, columnOf(text, path)));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind, path }, "backend");
});

it("does not link unsupported extensions or a supported extension inside a longer filename", async () => {
  const { term, openPage } = await mount();
  const text = "/tmp/report.pdf /tmp/source.ts /tmp/chart.png.backup /tmp/notes.md.txt";
  setLine(term, text);
  for (let x = 0; x < row(text).length; x++) expect(await linkAt(term, x)).toBeUndefined();
  expect(openPage).not.toHaveBeenCalled();
});

it.each([
  ["Read(/tmp/chart.png)", "/tmp/chart.png", "image"],
  ["read '/tmp/notes.md'", "/tmp/notes.md", "markdown"],
  ['open "/tmp/preview.html"', "/tmp/preview.html", "html"],
])("excludes surrounding parentheses and quotes in %s", async (text, path, kind) => {
  const { term, openPage } = await mount();
  setLine(term, text);
  const start = columnOf(text, path);
  const link = await linkAt(term, start);
  expect(link?.range).toEqual({ start: { x: start, y: 0 }, end: { x: start + path.length - 1, y: 0 } });
  await activate(link);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind, path }, "backend");
});

it.each([":12", ":12:3"])("excludes the source location suffix %s from the path and link range", async suffix => {
  const { term, openPage } = await mount();
  const path = "/tmp/chart.png";
  const text = `Read(${path}${suffix})`;
  setLine(term, text);
  const start = columnOf(text, path);
  await activate(await linkAt(term, start));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path }, "backend");
  expect(await linkAt(term, start + path.length)).toBeUndefined();
});

it("keeps Chinese path characters, excludes Chinese punctuation, and maps wide cells", async () => {
  const { term, openPage } = await mount();
  const path = "/tmp/图表.png";
  const text = `输出：${path}，下一步。`;
  setLine(term, text);
  const start = columnOf(text, path);
  const end = start + row(path).length - 1;
  const link = await linkAt(term, start);
  expect(link?.range).toEqual({ start: { x: start, y: 0 }, end: { x: end, y: 0 } });
  await activate(link);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path }, "backend");
  expect(await linkAt(term, end + 1)).toBeUndefined();
});

it.each([
  ["./x.png", "/workspace/project/src/x.png", "image"],
  ["out/y.md", "/workspace/project/src/out/y.md", "markdown"],
  ["../preview.html", "/workspace/project/preview.html", "html"],
  ["out/../../docs/notes.md", "/workspace/project/docs/notes.md", "markdown"],
])("resolves %s against the cwd reported by the real OSC 7 listener", async (relative, path, kind) => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace/project/src");
  setLine(term, `Read(${relative})`);
  await activate(await linkAt(term, "Read(".length));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind, path }, "backend");
});

it("uses a newly reported cwd instead of retaining the initial restored directory", async () => {
  const { term, openPage } = await mount({ session: { ...props.session, restoreCwd: "/old" } });
  await reportCwd("/workspace/latest");
  setLine(term, "./notes.md");
  await activate(await linkAt(term, 0));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "markdown", path: "/workspace/latest/notes.md" }, "backend");
});

it("does not reinterpret a relative path's slash as an absolute path without cwd", async () => {
  const { term, openPage } = await mount();
  const text = "./x.png out/y.md ../preview.html";
  setLine(term, text);
  for (let x = 0; x < text.length; x++) expect(await linkAt(term, x)).toBeUndefined();
  expect(openPage).not.toHaveBeenCalled();
});

it("opens the file, not a task dialog, when both providers cover a task code inside its path", async () => {
  const { term, openPage } = await mount({ taskLinks: { source, project: "smart-table" } });
  const path = "/tmp/T1090/place-pocket.png";
  const text = `Read(${path}) T1090`;
  // Wait for the actual board index before resolving the overlapping token.
  await waitFor(async () => {
    setLine(term, text);
    expect((await linkAt(term, text.lastIndexOf("T1090")))?.text).toBe("T1090");
  });
  const overlap = columnOf(text, "T1090") + 1;
  const candidates = (await Promise.all(term.providers.map((provider: ILinkProvider) =>
    new Promise<ILink[] | undefined>(resolve => provider.provideLinks(0, resolve)),
  ))).flatMap(links => links ?? []);
  // Establish that this click really overlaps a recognised task, not just a
  // task-shaped filename that would pass even with the wrong provider order.
  expect(candidates.some(link => link.text === "T1090" &&
    link.range.start.x <= overlap && overlap <= link.range.end.x)).toBe(true);
  await activate(await linkAt(term, overlap), { button: 0, ctrlKey: true });
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path }, "backend");
  expect(screen.queryByRole("dialog", { name: "任务详情" })).toBeNull();
});

it("preserves the task dialog for a standalone task code", async () => {
  const { term, openPage } = await mount({ taskLinks: { source, project: "smart-table" } });
  let link: ILink | undefined;
  await waitFor(async () => {
    setLine(term, "task T1090 ready");
    link = await linkAt(term, "task ".length);
    expect(link?.text).toBe("T1090");
  });
  await activate(link);
  expect(await screen.findByRole("dialog", { name: "任务详情" })).toBeTruthy();
  expect(await screen.findByRole("article", { name: "任务 T1090" })).toBeTruthy();
  expect(openPage).not.toHaveBeenCalled();
});

it("does not activate a path when the pointer ends a text selection", async () => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  const link = await linkAt(term, 1);
  term.getSelection.mockReturnValue("/tmp/chart.png");
  await activate(link, { button: 0, ctrlKey: true });
  expect(openPage).not.toHaveBeenCalled();
});

it("does not expose remote file links in a local shell", async () => {
  const { term, openPage } = await mount({ session: { id: "local-pane", server: LOCAL_SHELL, restoreCwd: "/workspace" } });
  const text = "/tmp/chart.png ./notes.md";
  setLine(term, text);
  for (let x = 0; x < text.length; x++) expect(await linkAt(term, x)).toBeUndefined();
  expect(openPage).not.toHaveBeenCalled();
});

it("does not activate a previously resolved path after the remote connection exits", async () => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  const link = await linkAt(term, 1);
  await act(async () => { mocks.listeners.get("ssh://backend/exit")!({ payload: 0 }); });
  await activate(link, { button: 0, ctrlKey: true });
  expect(openPage).not.toHaveBeenCalled();
});

it.each([1, 2])("does not activate a path with mouse button %i", async button => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  await activate(await linkAt(term, 1), { button, ctrlKey: true });
  expect(openPage).not.toHaveBeenCalled();
});

it.each([
  ["plain", {}], ["Ctrl", { ctrlKey: true }], ["Meta", { metaKey: true }],
])("accepts a %s left click, matching task-link activation without requiring a modifier", async (_label, modifiers) => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  await activate(await linkAt(term, 1), { button: 0, ...modifiers });
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/tmp/chart.png" }, "backend");
});
