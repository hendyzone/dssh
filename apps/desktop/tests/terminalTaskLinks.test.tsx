import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({ init: vi.fn(), invoke: vi.fn(), listen: vi.fn(), instances: [] as any[] }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({ default: "test.wasm" }));

/** Buffer rows as cells; a wide CJK char is followed by a zero spacer cell like ghostty. */
function row(text: string) {
  const cells: number[] = [];
  for (const char of text) { const cp = char.codePointAt(0)!; cells.push(cp); if (cp > 0x2e80) cells.push(0); }
  return { length: cells.length, isWrapped: false, getCell: (x: number) => (x < cells.length ? { getCodepoint: () => cells[x] } : undefined) };
}
vi.mock("ghostty-web", () => ({
  init: mocks.init,
  FitAddon: class { observeResize() {} fit() {} },
  Terminal: class {
    options: any; root?: HTMLElement; providers: any[] = []; rows: string[] = [];
    cols = 80;
    buffer = { active: { getLine: (y: number) => (this.rows[y] === undefined ? undefined : row(this.rows[y])) } };
    constructor(options: any) { this.options = options; mocks.instances.push(this); }
    loadAddon() {}
    open(root: HTMLElement) { this.root = root; root.innerHTML = '<textarea></textarea><canvas></canvas>'; }
    focus() {}
    write = vi.fn(); scrollToBottom = vi.fn(); getSelection = vi.fn(() => ""); hasMouseTracking = vi.fn(() => false); selectAll = vi.fn();
    registerLinkProvider(provider: any) { this.providers.push(provider); }
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    onResize() { return { dispose() {} }; }
    onRender() { return { dispose() {} }; }
    dispose() {}
  },
}));

import TerminalView from "../src/components/TerminalView";
import { createTaskLinkProvider, lineText } from "../src/lib/taskLinks";
import { boardSource, buildIndex, clearBoardCache, defaultLookupSettings } from "../src/lib/taskLookup";

const source = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test:8091" })!;
const props = {
  session: { id: "pane", server: { id: "server", name: "server", host: "example.com", port: 22, username: "root", authMethod: "password" as const } },
  active: true, inputEnabled: true,
  settings: { themeId: "tokyo-night", fontSize: 14, fontFamily: "monospace" },
  onBackendReady: vi.fn(),
};
const linksAt = (provider: any, y: number) => new Promise<any[] | undefined>(resolve => provider.provideLinks(y, resolve));

beforeEach(() => {
  clearBoardCache();
  mocks.instances.length = 0;
  mocks.init.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(() => {});
  const board = fakeInvoke();
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(async (command: string, args: any) => command === "ssh_connect" ? "backend" : board(command, args));
});

it("maps codes to cell columns, including after wide characters", async () => {
  const index = buildIndex("smart-table", [{ code: "T1090", title: "t", status_key: "doing", assignee: "", updated_at: "" }]).byCode;
  const term = { buffer: { active: { getLine: (y: number) => (y === 0 ? row("任务T1090 done") : undefined) } } };
  expect(lineText(row("任务T1"))).toBe("任 务 T1");
  const hover = vi.fn(); const activate = vi.fn();
  const provider = createTaskLinkProvider(term, { index: () => index, onHover: hover, onActivate: activate });
  const links = await linksAt(provider, 0);
  expect(links).toHaveLength(1);
  expect(links![0].range).toEqual({ start: { x: 4, y: 0 }, end: { x: 8, y: 0 } });
  links![0].hover(true);
  expect(hover).toHaveBeenCalledWith(expect.objectContaining({ code: "T1090" }));
  expect(await linksAt(createTaskLinkProvider(term, { index: () => undefined, onHover: hover, onActivate: activate }), 0)).toBeUndefined();
  expect(await linksAt(provider, 5)).toBeUndefined();
});

it("recognises only the project's real codes, shows a hover card and opens the full card on click", async () => {
  render(<TerminalView {...props} taskLinks={{ source, project: "smart-table" }}/>);
  await act(async () => { await new Promise(r => setTimeout(r, 25)); });
  const term = mocks.instances[0];
  expect(term.providers).toHaveLength(1);
  term.rows = ["worker: T1090 已交付，AM-42 不属于本项目，NOTE-1 也不是"];
  let links: any[] | undefined;
  await waitFor(async () => { links = await linksAt(term.providers[0], 0); expect(links).toHaveLength(1); });
  expect(links![0].text).toBe("T1090");

  await act(async () => { links![0].hover(true); });
  const tooltip = await screen.findByRole("tooltip");
  expect(tooltip.textContent).toContain("击球辅助线样式统一");
  expect(tooltip.textContent).toContain("cw3d-pi");
  await waitFor(() => expect(tooltip.textContent).toContain("待人工验收"));

  await act(async () => { links![0].activate(new MouseEvent("click", { button: 0 })); });
  const dialog = await screen.findByRole("dialog", { name: "任务详情" });
  expect(await screen.findByRole("article", { name: "任务 T1090" })).toBeTruthy();
  expect(screen.queryByRole("tooltip")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭任务详情" }));
  expect(dialog.isConnected).toBe(false);

  // A drag selection that ends on a code copies text instead of opening the card.
  term.getSelection.mockReturnValue("T1090");
  await act(async () => { links![0].activate(new MouseEvent("click", { button: 0 })); });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not query the board or recognise codes without a project", async () => {
  render(<TerminalView {...props}/>);
  await act(async () => { await new Promise(r => setTimeout(r, 25)); });
  const term = mocks.instances[0];
  term.rows = ["T1090"];
  expect(await linksAt(term.providers[0], 0)).toBeUndefined();
  expect(mocks.invoke.mock.calls.some(([command]) => command === "taskboard_get")).toBe(false);
});
