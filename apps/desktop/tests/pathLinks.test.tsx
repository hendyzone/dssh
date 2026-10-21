import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { ILink, ILinkProvider } from "ghostty-web";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({
  init: vi.fn(), invoke: vi.fn(), listen: vi.fn(), instances: [] as any[],
  listeners: new Map<string, (event: { payload: any }) => void>(),
  realConfig: null as { cols: number; rows: number; scrollbackLimit?: number } | null,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({ default: "test.wasm" }));

/** Match ghostty's buffer cells, including the spacer after a wide character. */
function row(text: string, isWrapped = false, columns = 0) {
  const cells: { codepoint: number; width: number }[] = [];
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const width = cp > 0x2e80 ? 2 : 1;
    cells.push({ codepoint: cp, width });
    if (width === 2) cells.push({ codepoint: 0, width: 0 });
  }
  while (cells.length < columns) cells.push({ codepoint: 0, width: 1 });
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
  const { Terminal: PointerTerminal, Ghostty } = await vi.importActual<typeof import("ghostty-web")>("ghostty-web");
  const { readFile } = await import("node:fs/promises");
  const { URL: NodeURL } = await import("node:url");
  const bytes = await readFile(new NodeURL("../../../vendor/ghostty-web/dist/ghostty-vt.wasm", import.meta.url));
  const ghostty = await Ghostty.loadFromBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
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
      realWasm: any;
      resizeListeners = new Set<(size: { cols: number; rows: number }) => void>();
      renderer = { charWidth: 10, charHeight: 20, setHoveredLinkRange: vi.fn(), setHoveredHyperlinkId: vi.fn() };
      wasmTerm: any = {
        getScrollbackLength: () => this.scrollback,
        getCursor: () => ({ x: this.cursorX, y: this.cursorY }),
        hasMouseTracking: () => this.hasMouseTracking(),
        getLine: (y: number) => Array.from(this.lines[this.scrollback + y] ?? "", () => ({ hyperlink_id: 0 })),
        getScrollbackLine: (y: number) => Array.from(this.lines[y] ?? "", () => ({ hyperlink_id: 0 })),
      };
      constructor(options: any) {
        this.options = { scrollback: mocks.realConfig?.scrollbackLimit ?? 10000, ...options };
        const terminal = this;
        this.buffer = { active: {
          // Match the real Buffer implementation: baseY is currently always 0.
          baseY: 0, type: "normal",
          get cursorY() { return terminal.cursorY; },
          get length() { return terminal.scrollback + terminal.rows; },
          getLine: (y: number) => this.lines[y] === undefined ? undefined : row(this.lines[y], y >= this.scrollback && this.wrapped.has(y), this.cols),
        } };
        if (mocks.realConfig) {
          this.cols = mocks.realConfig.cols;
          this.rows = mocks.realConfig.rows;
          this.realWasm = ghostty.createTerminal(this.cols, this.rows, mocks.realConfig);
          this.wasmTerm = this.realWasm;
          this.pointer = new PointerTerminal({ ghostty, cols: this.cols, rows: this.rows });
          this.pointer.wasmTerm = this.realWasm;
          this.buffer = this.pointer.buffer;
        }
        mocks.instances.push(this);
      }
      loadAddon() {}
      open(root: HTMLElement) {
        this.root = root;
        root.innerHTML = "<textarea></textarea><canvas></canvas>";
        // Retain the real terminal's hover/click handlers and built-in provider
        // ordering. Only its WASM buffer and drawing surface are replaced.
        this.pointer ??= new PointerTerminal({ ghostty: {} as any });
        Object.assign(this.pointer, {
          options: this.options, buffer: this.buffer, element: root, canvas: root.querySelector("canvas"),
          renderer: this.renderer, wasmTerm: this.wasmTerm, linkDetector: this.detector,
          isOpen: true, getViewportY: () => this.viewportY, requestRender: vi.fn(),
        });
        this.builtins = [new OSC8LinkProvider(this), new UrlRegexProvider(this)];
        this.builtins.forEach(provider => this.pointer.registerLinkProvider(provider));
        root.querySelector("canvas")!.addEventListener("mousemove", event => this.pointer.processMouseMove(event));
        root.querySelector("canvas")!.addEventListener("click", this.pointer.handleClick);
      }
      focus() {}
      write = vi.fn((data: string) => {
        if (this.realWasm) {
          this.realWasm.write(data);
          this.detector.invalidateCache();
          return;
        }
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
      onResize(callback: (size: { cols: number; rows: number }) => void) {
        this.resizeListeners.add(callback);
        return { dispose: () => { this.resizeListeners.delete(callback); } };
      }
      resize(cols: number, rows: number) {
        this.realWasm?.resize(cols, rows);
        this.cols = cols; this.rows = rows;
        this.pointer.cols = cols; this.pointer.rows = rows;
        // Ghostty publishes onResize only after the WASM grid has reflowed.
        // It does not invalidate the link detector's cached ILink objects here.
        for (const callback of this.resizeListeners) callback({ cols, rows });
      }
      onRender() { return { dispose() {} }; }
      dispose() {
        this.pointer.isDisposed = true; this.pointer.isOpen = false; this.detector.dispose();
        this.realWasm?.free();
        this.pointer.wasmTerm = undefined;
      }
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
  mocks.realConfig = null;
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
  return { ...view, term: mocks.instances[0], openPage, onStateChange };
}

async function mountReal(config = { cols: 80, rows: 12, scrollbackLimit: 10000 }, overrides: Partial<ComponentProps<typeof TerminalView>> = {}) {
  mocks.realConfig = config;
  return mount(overrides);
}

function bufferText(term: any, y: number): string {
  const line = term.buffer.active.getLine(y);
  if (!line) return "";
  return Array.from({ length: line.length }, (_, x) => {
    const cp = line.getCell(x)?.getCodepoint() ?? 0;
    return cp >= 32 ? String.fromCodePoint(cp) : " ";
  }).join("").trimEnd();
}

function findBufferRow(term: any, text: string): number {
  for (let y = 0; y < term.buffer.active.length; y++) if (bufferText(term, y) === text) return y;
  throw new Error(`Terminal row not found: ${text}`);
}

function cursorRow(term: any): number {
  return term.buffer.active.length - term.rows + term.buffer.active.cursorY;
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

async function emitOutput(payload: string, backend = "backend") {
  const listener = mocks.listeners.get(`ssh://${backend}/data`);
  expect(listener).toBeDefined();
  await act(async () => { listener!({ payload }); });
}

const osc7 = (cwd: string) => `\x1b]7;file://example.com${encodeURI(cwd)}\x07`;

async function finishInitialization(backend = "backend") {
  const command = mocks.invoke.mock.calls.findLast(([name, args]) => name === "ssh_write" && args.sessionId === backend)?.[1].data as string;
  const marker = command.match(/dssh-init-[a-f0-9-]+/)![0];
  await emitOutput(`\x1b]1337;${marker}\x07`, backend);
}

async function reportCwd(cwd: string, backend = "backend") {
  await finishInitialization(backend);
  await emitOutput(osc7(cwd), backend);
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

it.each([false, true])("never offers relative paths as links (OSC 7 received: %s)", async reported => {
  const { term, openPage } = await mount();
  if (reported) await reportCwd("/workspace");
  const text = "./a.png out/a.md ../preview.html";
  setLine(term, text);
  expect(await allCandidates(term)).toEqual([]);
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
  const path = "/tmp/chart.png";
  const text = `${prefix}${path}`;
  setLine(term, text);
  const link = await linkAt(term, prefix.length);
  expect(link?.range.start.x).toBe(prefix.length);
  await activate(link);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "image", path }, "backend");
});

it("separates comma-delimited absolute paths", async () => {
  const { term, openPage } = await mount();
  const text = "/tmp/a.png,/tmp/b.png";
  setLine(term, text);
  await activate(await linkAt(term, 1));
  await activate(await linkAt(term, text.indexOf("/tmp/b")));
  expect(openPage.mock.calls).toEqual([
    [{ kind: "image", path: "/tmp/a.png" }, "backend"],
    [{ kind: "image", path: "/tmp/b.png" }, "backend"],
  ]);
  expect(await linkAt(term, text.indexOf(","))).toBeUndefined();
});

it("does not link bare filenames after an OSC 7 report", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  const text = "a.png README.md a.png,b.png";
  setLine(term, text);
  expect(await allCandidates(term)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});

it("does not turn a visible wrapped slash fragment into an absolute path", async () => {
  const { term, openPage } = await mountReal({ cols: 12, rows: 5, scrollbackLimit: 10000 });
  await finishInitialization();
  await emitOutput("/home/u/proj/docs/a.md");
  expect(bufferText(term, 1)).toBe("/docs/a.md");
  expect(term.buffer.active.getLine(1).isWrapped).toBe(true);
  expect(await linkAt(term, 1, 1)).toBeUndefined();
  expect(openPage).not.toHaveBeenCalled();
});

it("does not link the apparent supported suffix before a wrapped filename continuation", async () => {
  const { term } = await mountReal({ cols: 14, rows: 5, scrollbackLimit: 10000 });
  await finishInitialization();
  await emitOutput("/tmp/chart.png.backup");
  expect(bufferText(term, 0)).toBe("/tmp/chart.png");
  expect(term.buffer.active.getLine(0).isWrapped).toBe(false);
  expect(term.buffer.active.getLine(1).isWrapped).toBe(true);
  expect(await linkAt(term, 1, 0)).toBeUndefined();
});

it("does not link a tilde path after an OSC 7 report", async () => {
  const { term, openPage } = await mount();
  await reportCwd("/workspace");
  setLine(term, "~/chart.png");
  expect(await allCandidates(term)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});

it("does not add a file-path candidate inside a URL already handled by the built-in provider", async () => {
  const { term, openPage } = await mount();
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
    // Exercise discovery independently of activate's second enabled check.
    expect(await allCandidates(term)).toEqual([]);
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

it("keeps two absolute paths separate across an unwritten terminal cell", async () => {
  const { term, openPage } = await mountReal();
  await finishInitialization();
  // Cursor-forward leaves a real width-1/codepoint-0 cell; writing a NUL byte
  // would be ignored by the terminal and would not exercise this boundary.
  await emitOutput("/tmp/a.md\x1b[C/tmp/b.md");
  const empty = term.buffer.active.getLine(0).getCell(9);
  expect(empty.getCodepoint()).toBe(0);
  expect(empty.getWidth()).toBe(1);
  expect((await allCandidates(term)).map(link => link.text)).toEqual(["/tmp/a.md", "/tmp/b.md"]);
  await clickAt(term, 1, { ctrlKey: true });
  await clickAt(term, 11, { ctrlKey: true });
  expect(openPage.mock.calls).toEqual([
    [{ kind: "markdown", path: "/tmp/a.md" }, "backend"],
    [{ kind: "markdown", path: "/tmp/b.md" }, "backend"],
  ]);
});

it("invalidates a cached absolute link after widening reflow", async () => {
  const { term, openPage } = await mountReal({ cols: 20, rows: 12, scrollbackLimit: 10000 });
  await finishInitialization();
  await emitOutput("x".repeat(70) + "\r\n/tmp/old.md\r\nprompt");
  const oldRow = findBufferRow(term, "/tmp/old.md");
  const cached = await linkAt(term, 1, oldRow);
  expect(oldRow).toBe(4);
  expect(cached).toBeDefined();
  await act(async () => { term.resize(80, 12); });
  expect(findBufferRow(term, "/tmp/old.md")).toBe(1);
  expect(cursorRow(term)).toBe(2);
  // The real vendor leaves the detector cache intact on resize.
  expect(await linkAt(term, 1, oldRow)).toBe(cached);
  await activate(cached);
  expect(openPage).not.toHaveBeenCalled();
  await clickAt(term, 1, { ctrlKey: true }, 1);
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "markdown", path: "/tmp/old.md" }, "backend");
});

it("invalidates a cached absolute link after a rows-only resize", async () => {
  const { term, openPage } = await mountReal();
  await finishInitialization();
  await emitOutput("/tmp/earlier.md\r\nprompt");
  const cached = await linkAt(term, 1, 0);
  expect(cached).toBeDefined();
  await act(async () => { term.resize(80, 6); });
  expect(term.cols).toBe(80);
  expect(term.rows).toBe(6);
  expect(cursorRow(term)).toBe(1);
  expect(term.buffer.active.length - term.rows).toBe(0);
  expect(bufferText(term, 0)).toBe("/tmp/earlier.md");
  expect(term.buffer.active.getLine(0).isWrapped).toBe(false);
  expect(await linkAt(term, 1, 0)).toBe(cached);
  await activate(cached);
  expect(openPage).not.toHaveBeenCalled();
  await emitOutput("\r\n/tmp/fresh.md");
  await clickAt(term, 1, { ctrlKey: true }, cursorRow(term));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "markdown", path: "/tmp/fresh.md" }, "backend");
});

it("does not link an absolute history token ending at the last terminal column", async () => {
  const { term, openPage } = await mountReal({ cols: 10, rows: 5, scrollbackLimit: 10000 });
  await finishInitialization();
  await emitOutput("/tmp/a.png\r\n" + "\r\n".repeat(5));
  expect(bufferText(term, 0)).toBe("/tmp/a.png");
  expect(term.buffer.active.length - term.rows).toBeGreaterThan(0);
  expect(term.buffer.active.getLine(0).isWrapped).toBe(false);
  expect(term.buffer.active.getLine(0).getCell(term.cols - 1).getCodepoint()).not.toBe(0);
  expect(await allCandidates(term, 0)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});

it("does not turn a historical wrapped slash fragment into an absolute path", async () => {
  const { term, openPage } = await mountReal({ cols: 12, rows: 5, scrollbackLimit: 10000 });
  await finishInitialization();
  await emitOutput("/home/u/proj/docs/a.md");
  expect(bufferText(term, 0)).toBe("/home/u/proj");
  expect(bufferText(term, 1)).toBe("/docs/a.md");
  expect(term.buffer.active.getLine(1).isWrapped).toBe(true);
  await emitOutput("\r\n".repeat(6));
  expect(term.buffer.active.length - term.rows).toBeGreaterThan(1);
  expect(term.buffer.active.getLine(1).isWrapped).toBe(false);
  expect(bufferText(term, 1).startsWith("/docs/a.md")).toBe(true);
  expect(term.buffer.active.getLine(1).getCell(term.cols - 1).getCodepoint()).toBe(0);
  expect(term.buffer.active.getLine(0).getCell(term.cols - 1).getCodepoint()).not.toBe(0);
  expect(await allCandidates(term, 1)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});

it("keeps a complete absolute history path away from both ambiguous wrap boundaries clickable", async () => {
  const { term, openPage } = await mountReal({ cols: 20, rows: 5, scrollbackLimit: 10000 });
  await finishInitialization();
  await emitOutput("\r\n/tmp/complete.md\r\n" + "\r\n".repeat(6));
  expect(term.buffer.active.length - term.rows).toBeGreaterThan(1);
  expect(term.buffer.active.getLine(0).getCell(term.cols - 1).getCodepoint()).toBe(0);
  expect(term.buffer.active.getLine(1).getCell(term.cols - 1).getCodepoint()).toBe(0);
  await activate(await linkAt(term, 1, 1));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "markdown", path: "/tmp/complete.md" }, "backend");
});

it("invalidates old absolute links after reconnect and opens new links against the new backend", async () => {
  const previousInvoke = mocks.invoke.getMockImplementation()!;
  let connects = 0;
  mocks.invoke.mockImplementation((command: string, args: any) => command === "ssh_connect"
    ? Promise.resolve(++connects === 1 ? "backend" : "backend-next") : previousInvoke(command, args));
  const { term, openPage, onStateChange } = await mountReal();
  await finishInitialization();
  await emitOutput("/tmp/old.md\r\n");
  const cached = await linkAt(term, 1, 0);
  expect(cached).toBeDefined();
  await act(async () => { mocks.listeners.get("ssh://backend/exit")!({ payload: 0 }); });
  fireEvent.click(screen.getByRole("button", { name: "[已断开] 点此重连" }));
  await waitFor(() => expect(onStateChange.mock.calls.filter(([, state]) => state === "connected")).toHaveLength(2));
  expect(mocks.instances).toHaveLength(1);
  await activate(cached);
  expect(openPage).not.toHaveBeenCalled();
  await finishInitialization("backend-next");
  await emitOutput("/tmp/fresh.md", "backend-next");
  await clickAt(term, 1, { ctrlKey: true }, cursorRow(term));
  expect(openPage).toHaveBeenCalledExactlyOnceWith({ kind: "markdown", path: "/tmp/fresh.md" }, "backend-next");
});

it("does not activate an old disposed provider after the same view connects a different session", async () => {
  const { term, openPage, onStateChange, rerender } = await mount();
  setLine(term, "/tmp/old.md");
  const cached = await linkAt(term, 1);
  expect(cached).toBeDefined();
  const previousInvoke = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string, args: any) => command === "ssh_connect"
    ? Promise.resolve("backend-next") : previousInvoke(command, args));
  const backendReady = vi.fn();
  const nextSession = { ...props.session, id: "next-pane" };
  rerender(<TerminalView {...props} session={nextSession} onOpenPage={openPage} onStateChange={onStateChange} onBackendReady={backendReady}/>);
  await waitFor(() => expect(onStateChange).toHaveBeenCalledWith("next-pane", "connected"));
  expect(backendReady).toHaveBeenCalledWith("next-pane", "backend-next");
  expect(mocks.instances).toHaveLength(2);
  await activate(cached);
  expect(openPage).not.toHaveBeenCalled();
});

it("checks backend availability during the synchronous exit notification before state changes", async () => {
  let cached: ILink | undefined;
  const backendReady = vi.fn((_pane: string, backend: string | null) => {
    if (backend === null && cached) cached.activate(new MouseEvent("click", { button: 0, ctrlKey: true, detail: 1 }));
  });
  const { term, openPage, onStateChange } = await mount({ onBackendReady: backendReady });
  setLine(term, "/tmp/old.md");
  cached = await linkAt(term, 1);
  expect(cached).toBeDefined();
  const statesSeen: string[] = [];
  backendReady.mockImplementation((_pane: string, backend: string | null) => {
    if (backend === null && cached) {
      statesSeen.push(onStateChange.mock.calls.at(-1)![1]);
      cached.activate(new MouseEvent("click", { button: 0, ctrlKey: true, detail: 1 }));
    }
  });
  await act(async () => { mocks.listeners.get("ssh://backend/exit")!({ payload: 0 }); });
  expect(statesSeen).toEqual(["connected"]);
  expect(backendReady).toHaveBeenLastCalledWith("pane", null);
  expect(onStateChange).toHaveBeenLastCalledWith("pane", "disconnected");
  expect(openPage).not.toHaveBeenCalled();
});

it("stops offering links when the existing view loses its page callback", async () => {
  const { term, openPage, onStateChange, rerender } = await mount();
  setLine(term, "/tmp/chart.png");
  expect((await allCandidates(term)).map(link => link.text)).toEqual(["/tmp/chart.png"]);
  rerender(<TerminalView {...props} onStateChange={onStateChange}/>);
  expect(mocks.instances).toHaveLength(1);
  expect(onStateChange).toHaveBeenLastCalledWith("pane", "connected");
  expect(await allCandidates(term)).toEqual([]);
  expect(openPage).not.toHaveBeenCalled();
});
