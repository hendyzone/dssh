import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
function row(text: string, isWrapped = false) {
  const cells: { codepoint: number; width: number }[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const width = cp > 0x2e80 ? 2 : 1;
    cells.push({ codepoint: cp, width });
    if (width === 2) cells.push({ codepoint: 0, width: 0 });
  }
  return {
    length: cells.length, isWrapped,
    getCell: (x: number) => x < cells.length
      ? { getCodepoint: () => cells[x].codepoint, getWidth: () => cells[x].width, getHyperlinkId: () => 0 }
      : undefined,
  };
}

vi.mock("ghostty-web", async () => {
  // Use the real detector: earlier registered providers win at overlapping cells.
  // Selecting the path provider directly would hide a broken registration order.
  const { LinkDetector } = await import("../../../vendor/ghostty-web/lib/link-detector");
  const { OSC8LinkProvider } = await import("../../../vendor/ghostty-web/lib/providers/osc8-link-provider");
  const { UrlRegexProvider } = await import("../../../vendor/ghostty-web/lib/providers/url-regex-provider");
  const { Terminal: PointerTerminal } = await vi.importActual<typeof import("ghostty-web")>("ghostty-web");
  return {
    init: mocks.init,
    FitAddon: class { observeResize() {} fit() {} },
    Terminal: class {
      options: any; root?: HTMLElement; providers: ILinkProvider[] = []; builtins: ILinkProvider[] = [];
      lines: string[] = []; wrapped = new Set<number>();
      cols = 80; rows = 24; viewportY = 0; cursorY = 0; cursorX = 0; scrollback = 0; vtCarry = "";
      buffer: any;
      detector = new LinkDetector(this);
      pointer: any;
      renderer = { charWidth: 10, charHeight: 20, setHoveredLinkRange: vi.fn(), setHoveredHyperlinkId: vi.fn() };
      wasmTerm = {
        getScrollbackLength: () => this.scrollback,
        getCursor: () => ({ x: this.cursorX, y: this.cursorY }),
        hasMouseTracking: () => this.hasMouseTracking(),
        getLine: (y: number) => Array.from(this.lines[this.scrollback + y] ?? "", () => ({ hyperlink_id: 0 })),
        getScrollbackLine: (y: number) => Array.from(this.lines[y] ?? "", () => ({ hyperlink_id: 0 })),
      };
      constructor(options: any) {
        this.options = options;
        const terminal = this;
        this.buffer = { active: {
          // Match the real Buffer implementation: baseY is currently always 0.
          baseY: 0, type: "normal",
          get cursorY() { return terminal.cursorY; },
          get length() { return terminal.scrollback + terminal.rows; },
          getLine: (y: number) => this.lines[y] === undefined ? undefined : row(this.lines[y], y >= this.scrollback && this.wrapped.has(y)),
        } };
        mocks.instances.push(this);
      }
      loadAddon() {}
      open(root: HTMLElement) {
        this.root = root;
        root.innerHTML = "<textarea></textarea><canvas></canvas>";
        // Retain the real terminal's hover/click handlers and built-in provider
        // ordering. Only its WASM buffer and drawing surface are replaced.
        this.pointer = new PointerTerminal({ ghostty: {} as any });
        Object.assign(this.pointer, {
          options: this.options, buffer: this.buffer, element: root, canvas: root.querySelector("canvas"),
          renderer: this.renderer, wasmTerm: this.wasmTerm, linkDetector: this.detector,
          isOpen: true, getViewportY: () => 0, requestRender: vi.fn(),
        });
        this.builtins = [new OSC8LinkProvider(this), new UrlRegexProvider(this)];
        this.builtins.forEach(provider => this.pointer.registerLinkProvider(provider));
        root.querySelector("canvas")!.addEventListener("mousemove", event => this.pointer.processMouseMove(event));
        root.querySelector("canvas")!.addEventListener("click", this.pointer.handleClick);
      }
      focus() {}
      write = vi.fn((data: string) => {
        // Advance the cursor through the real output callback, including
        // scrollback. OSC/CSI sequences themselves consume no terminal cells.
        let bytes = this.vtCarry + data;
        this.vtCarry = bytes.match(/\x1b(?:\][^\x07\x1b]*|\[[0-?]*[ -/]*)?$/)?.[0] ?? "";
        if (this.vtCarry) bytes = bytes.slice(0, -this.vtCarry.length);
        const text = bytes.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g, "");
        for (const char of text) {
          if (char === "\r") this.cursorX = 0;
          else if (char === "\n") {
            if (++this.cursorY >= this.rows) { this.scrollback++; this.cursorY = this.rows - 1; }
          } else if (char >= " ") {
            const y = this.scrollback + this.cursorY;
            const previous = this.lines[y] ?? "";
            this.lines[y] = previous.slice(0, this.cursorX) + char + previous.slice(this.cursorX + char.length);
            this.cursorX += char.length;
          }
        }
        this.detector.invalidateCache();
      });
      scrollToBottom = vi.fn(); getSelection = vi.fn(() => "");
      hasMouseTracking = vi.fn(() => false); selectAll = vi.fn();
      registerLinkProvider(provider: ILinkProvider) {
        this.providers.push(provider);
        this.pointer.registerLinkProvider(provider);
      }
      attachCustomKeyEventHandler() {}
      onData() { return { dispose() {} }; }
      onResize() { return { dispose() {} }; }
      onRender() { return { dispose() {} }; }
      dispose() { this.pointer.isDisposed = true; this.pointer.isOpen = false; this.detector.dispose(); }
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

async function linkAt(term: any, column: number, y = 0): Promise<ILink | undefined> {
  return term.detector.getLinkAt(column, y);
}

async function activate(link: ILink | undefined, init: MouseEventInit = { button: 0, ctrlKey: true, detail: 1 }) {
  expect(link).toBeDefined();
  await act(async () => { link!.activate(new MouseEvent("click", init)); });
}

async function clickAt(term: any, column: number, init: MouseEventInit = {}, y = 0) {
  await act(async () => {
    const event = new MouseEvent("click", {
      bubbles: true, cancelable: true, clientX: column * 10 + 1, clientY: y * 20 + 1, button: 0, detail: 1, ...init,
    });
    // Vitest's Window proxy fails jsdom's constructor identity check. Supply
    // the event's real owner window afterward so URL activation can call open.
    Object.defineProperty(event, "view", { value: term.root.ownerDocument.defaultView });
    fireEvent(term.root.querySelector("canvas"), event);
  });
}

async function allCandidates(term: any, y = 0): Promise<ILink[]> {
  return (await Promise.all([...term.builtins, ...term.providers].map((provider: ILinkProvider) =>
    new Promise<ILink[] | undefined>(resolve => provider.provideLinks(y, resolve)),
  ))).flatMap(links => links ?? []);
}

async function emitOutput(payload: string) {
  const listener = mocks.listeners.get("ssh://backend/data");
  expect(listener).toBeDefined();
  await act(async () => { listener!({ payload }); });
}

const osc7 = (cwd: string) => `\x1b]7;file://example.com${encodeURI(cwd)}\x07`;

async function reportCwd(cwd: string) {
  const listener = mocks.listeners.get("ssh://backend/data");
  expect(listener).toBeDefined();
  const command = mocks.invoke.mock.calls.find(([name]) => name === "ssh_write")?.[1].data as string;
  const marker = command.match(/dssh-init-[a-f0-9-]+/)![0];
  await act(async () => {
    listener!({ payload: `\x1b]1337;${marker}\x07${osc7(cwd)}` });
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
  await clickAt(term, overlap);
  expect(openPage).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "任务详情" })).toBeNull();
  term.getSelection.mockReturnValue("T1090");
  await clickAt(term, overlap, { ctrlKey: true });
  expect(openPage).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "任务详情" })).toBeNull();
  term.getSelection.mockReturnValue("");
  await clickAt(term, overlap, { ctrlKey: true, detail: 2 });
  expect(openPage).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "任务详情" })).toBeNull();
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
  await activate(link, { button: 0, detail: 1 });
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

it("does not open a path on an unmodified focus click", async () => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  expect(await linkAt(term, 1)).toBeDefined();
  await clickAt(term, 1);
  expect(openPage).not.toHaveBeenCalled();
});

it.each([
  ["Ctrl", { ctrlKey: true }], ["Meta", { metaKey: true }],
])("opens a path with a %s click through the real terminal click handler", async (_label, modifiers) => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  await clickAt(term, 1, modifiers);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/tmp/chart.png" }, "backend");
});

it("does not open a second page for the second click of a modified double click", async () => {
  const { term, openPage } = await mount();
  setLine(term, "/tmp/chart.png");
  await clickAt(term, 1, { ctrlKey: true, detail: 1 });
  expect(openPage).toHaveBeenCalledTimes(1);
  // No artificial selection: the detail guard itself must stop the extra open.
  expect(term.getSelection()).toBe("");
  await clickAt(term, 1, { ctrlKey: true, detail: 2 });
  expect(openPage).toHaveBeenCalledTimes(1);
});

it.each([".", ",", ";", "!", "?", ":", "…", "—", ":12:", ":12:3:"])(
  "strips trailing punctuation %s before resolving the source location",
  async punctuation => {
    const { term, openPage } = await mount();
    const path = "/tmp/chart.png";
    const text = `wrote ${path}${punctuation}`;
    setLine(term, text);
    const start = columnOf(text, path);
    const link = await linkAt(term, start);
    expect(link?.range.end.x).toBe(start + path.length - 1);
    await activate(link);
    expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path }, "backend");
    expect(await linkAt(term, start + path.length)).toBeUndefined();
  },
);

it.each(["key=", "--out="])("separates the assignment prefix %s from an absolute path", async prefix => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  const path = "/tmp/chart.png";
  const text = `${prefix}${path}`;
  setLine(term, text);
  const link = await linkAt(term, prefix.length);
  expect(link?.range.start.x).toBe(prefix.length);
  await activate(link);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path }, "backend");
});

it("separates comma-delimited explicit relative paths", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  const text = "./a.png,./b.png";
  setLine(term, text);
  await activate(await linkAt(term, 1));
  await activate(await linkAt(term, text.indexOf("./b")));
  expect(openPage.mock.calls).toEqual([
    [{ kind: "image", path: "/workspace/a.png" }, "backend"],
    [{ kind: "image", path: "/workspace/b.png" }, "backend"],
  ]);
  expect(await linkAt(term, text.indexOf(","))).toBeUndefined();
});

it("does not link bare filenames even when cwd is known", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  const text = "a.png README.md a.png,b.png";
  setLine(term, text);
  expect(await allCandidates(term)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});

it("does not resolve a wrapped continuation as a new relative path", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  term.lines = ["long output prefix/", "out/chart.png"];
  term.cols = row(term.lines[0]).length;
  term.wrapped.add(1);
  term.detector.invalidateCache();
  expect(await linkAt(term, 1, 1)).toBeUndefined();
  expect(openPage).not.toHaveBeenCalled();
});

it("does not link the apparent supported suffix before a wrapped filename continuation", async () => {
  const { term } = await mount();
  term.lines = ["/tmp/chart.png", ".backup"];
  term.cols = row(term.lines[0]).length;
  term.wrapped.add(1);
  term.detector.invalidateCache();
  expect(await linkAt(term, 1, 0)).toBeUndefined();
});

it("rejects old relative rows and cached links after cd, while keeping absolute paths usable", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/old");
  await emitOutput("./old.png /tmp/absolute.png\r\n");
  const oldRelative = await linkAt(term, 1, 0);
  expect(oldRelative).toBeDefined();
  const oldAbsolute = await linkAt(term, "./old.png ".length + 1, 0);
  expect(oldAbsolute).toBeDefined();
  // Keep both rows visible so a history-row guard cannot hide a broken cwd fence.
  await emitOutput("\r\n".repeat(2) + osc7("/new") + "./fresh.png");
  expect(term.scrollback).toBe(0);
  const currentRow = term.buffer.active.length - term.rows + term.buffer.active.cursorY;
  expect(currentRow).toBe(3);
  expect(await linkAt(term, 1, 0)).toBeUndefined();
  await activate(oldRelative);
  expect(openPage).not.toHaveBeenCalled();
  await activate(oldAbsolute);
  expect(openPage).toHaveBeenLastCalledWith({ kind: "image", path: "/tmp/absolute.png" }, "backend");
  await activate(await linkAt(term, 1, currentRow));
  expect(openPage).toHaveBeenLastCalledWith({ kind: "image", path: "/new/fresh.png" }, "backend");
  expect(openPage).toHaveBeenCalledTimes(2);
});

it("rejects history relative paths with missing wrap metadata while retaining absolute paths", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  await emitOutput("./old.png /tmp/absolute.png\r\n");
  const oldRelative = await linkAt(term, 1, 0);
  expect(oldRelative).toBeDefined();
  await emitOutput("\r\n".repeat(30));
  expect(term.scrollback).toBeGreaterThan(0);
  expect(term.buffer.active.baseY).toBe(0);
  expect(term.buffer.active.getLine(0).isWrapped).toBe(false);
  // cwd never changed, so only the missing history wrap metadata justifies
  // withholding this relative path; a cwd-age guard cannot mask this test.
  expect(await linkAt(term, 1, 0)).toBeUndefined();
  await activate(oldRelative);
  expect(openPage).not.toHaveBeenCalled();
  await activate(await linkAt(term, "./old.png ".length + 1, 0));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/tmp/absolute.png" }, "backend");
});

it("records the cwd boundary at OSC 7 within a chunk, before later output advances the cursor", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/old");
  await emitOutput("./old.png\r\n" + osc7("/new") + "./fresh.png\r\nnext prompt");
  expect(term.cursorY).toBe(2);
  expect(await linkAt(term, 1, 0)).toBeUndefined();
  await activate(await linkAt(term, 1, 1));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/new/fresh.png" }, "backend");
});

it("does not change a displayed row's cwd until its synchronized output is written", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/old");
  await emitOutput("./old.png");
  const oldRelative = await linkAt(term, 1, 0);
  expect(oldRelative).toBeDefined();
  await emitOutput("\x1b[?2026h\r\n" + osc7("/new") + "./fresh.png");
  expect(term.cursorY).toBe(0);
  await activate(oldRelative);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/old/old.png" }, "backend");
  await emitOutput("\x1b[?2026l");
  expect(term.cursorY).toBe(1);
  await activate(oldRelative);
  expect(openPage).toHaveBeenCalledTimes(1);
  await activate(await linkAt(term, 1, 1));
  expect(openPage).toHaveBeenLastCalledWith({ kind: "image", path: "/new/fresh.png" }, "backend");
});

it("updates the cwd boundary only when a split OSC 7 sequence completes", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/old");
  await emitOutput("./old.png");
  const oldRelative = await linkAt(term, 1, 0);
  expect(oldRelative).toBeDefined();
  await emitOutput("\r\n\x1b]7;file://example.com/ne");
  await activate(oldRelative);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/old/old.png" }, "backend");
  await emitOutput("w\x07./fresh.png");
  expect(term.cursorY).toBe(1);
  await activate(oldRelative);
  expect(openPage).toHaveBeenCalledTimes(1);
  await activate(await linkAt(term, 1, 1));
  expect(openPage).toHaveBeenLastCalledWith({ kind: "image", path: "/new/fresh.png" }, "backend");
});

it("does not transfer a cwd between normal and alternate buffers without a fresh report", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  term.buffer.active.type = "alternate";
  setLine(term, "./alt.png /tmp/absolute.png");
  expect(await linkAt(term, 1)).toBeUndefined();
  await activate(await linkAt(term, "./alt.png ".length + 1));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path: "/tmp/absolute.png" }, "backend");
  await reportCwd("/workspace");
  term.detector.invalidateCache();
  await activate(await linkAt(term, 1));
  expect(openPage).toHaveBeenLastCalledWith({ kind: "image", path: "/workspace/alt.png" }, "backend");
});

it("does not treat a tilde path as relative when remote HOME is unavailable", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  setLine(term, "~/chart.png");
  expect(await allCandidates(term)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});

it("does not add a file-path candidate inside a URL already handled by the built-in provider", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  const url = "https://example.test/chart.png";
  setLine(term, url);
  const candidates = await allCandidates(term);
  expect(candidates).toHaveLength(1);
  expect(candidates[0].text).toBe(url);
  expect(openPage).not.toHaveBeenCalled();
});

it("requires connected state even after the backend id exists during SSH initialization", async () => {
  let finishStart!: () => void;
  const starting = new Promise<void>(resolve => { finishStart = resolve; });
  const previousInvoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: any) =>
    command === "ssh_start" ? starting : previousInvoke(command, args));
  const openPage = vi.fn();
  const backendReady = vi.fn();
  const stateChange = vi.fn();
  render(<TerminalView {...props} onOpenPage={openPage} onBackendReady={backendReady} onStateChange={stateChange}/>);
  try {
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ssh_start", { sessionId: "backend" }));
    expect(backendReady).toHaveBeenCalledWith("pane", "backend");
    expect(stateChange).toHaveBeenLastCalledWith("pane", "connecting");
    expect(stateChange).not.toHaveBeenCalledWith("pane", "connected");
    const term = mocks.instances[0];
    setLine(term, "/tmp/chart.png");
    await clickAt(term, 1, { ctrlKey: true });
    expect(openPage).not.toHaveBeenCalled();
  } finally {
    await act(async () => { finishStart(); });
  }
});

it.each([false, true])("matches built-in URL hover and click behavior with mouse tracking %s", async tracking => {
  const { term, openPage } = await mount();
  term.hasMouseTracking.mockReturnValue(tracking);
  const externalOpen = vi.spyOn(term.root.ownerDocument.defaultView, "open").mockImplementation(() => null);
  try {
    setLine(term, "/tmp/chart.png");
    await act(async () => { fireEvent.mouseMove(term.root.querySelector("canvas"), { clientX: 11, clientY: 1 }); });
    expect(term.renderer.setHoveredLinkRange).toHaveBeenLastCalledWith(expect.objectContaining({ startX: 0, endX: 13 }));
    await clickAt(term, 1);
    expect(openPage).not.toHaveBeenCalled();
    await clickAt(term, 1, { ctrlKey: true });
    expect(openPage).toHaveBeenCalledTimes(1);
    const url = "https://example.test/chart.png";
    setLine(term, url);
    await act(async () => { fireEvent.mouseMove(term.root.querySelector("canvas"), { clientX: 11, clientY: 1 }); });
    expect(term.renderer.setHoveredLinkRange).toHaveBeenLastCalledWith(expect.objectContaining({ startX: 0, endX: url.length - 1 }));
    await clickAt(term, 1);
    expect(externalOpen).not.toHaveBeenCalled();
    await clickAt(term, 1, { ctrlKey: true });
    expect(externalOpen).toHaveBeenCalledExactlyOnceWith(url, "_blank", "noopener,noreferrer");
    expect(openPage).toHaveBeenCalledTimes(1);
  } finally { externalOpen.mockRestore(); }
});
