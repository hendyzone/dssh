import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import SftpPanel from "../src/components/SftpPanel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/lib/transfers", () => ({
  subscribeTransfers: () => () => {}, createTransfer: () => "transfer",
  waitForTransferListener: async () => {}, formatTransferSize: () => "", transferPercent: () => 0,
}));
const callbacks = new Map<string, (event: any) => void>();
const hitTest = vi.fn();
const file = { name: "note.txt", path: "/note.txt", isDir: false };
const folder = { name: "folder", path: "/folder", isDir: true };
const nested = { name: "nested", path: "/folder/nested", isDir: true };
let listing: Record<string, typeof file[]>;

beforeEach(() => {
  callbacks.clear();
  hitTest.mockReset();
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse";
    }
  });
  vi.stubGlobal("devicePixelRatio", 2);
  Object.defineProperty(document, "elementFromPoint", { configurable: true, value: hitTest });
  vi.mocked(listen).mockImplementation(async (name, callback) => {
    callbacks.set(name, callback); return () => { callbacks.delete(name); };
  });
  listing = { "/": [file, folder], "/folder": [nested], "/folder/nested": [] };
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "sftp_home") return "/";
    if (command === "sftp_list") return listing[args.path] ?? [];
    if (command === "sftp_rename") {
      listing["/"] = listing["/"].filter((entry) => entry.path !== args.oldPath);
    }
    return undefined;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function setup() {
  const view = render(<SftpPanel sessionId="session" onClose={() => {}} />);
  await screen.findByText("note.txt");
  const panel = view.container.querySelector("aside")!;
  panel.setPointerCapture = vi.fn();
  panel.hasPointerCapture = vi.fn(() => true);
  panel.releasePointerCapture = vi.fn();
  return { ...view, panel };
}
function row(name: string) { return screen.getByText(name).closest(".sftp-tree-row")!; }
function drag(panel: HTMLElement, source: Element, destination: Element | null) {
  hitTest.mockReturnValue(destination);
  fireEvent.pointerDown(source, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
  fireEvent.pointerMove(panel, { clientX: 30, clientY: 40, pointerId: 1 });
  fireEvent.pointerUp(panel, { clientX: 30, clientY: 40, pointerId: 1 });
}
async function nativeDrop(destination: Element | null, paths = ["C:\\upload.txt"]) {
  hitTest.mockReturnValue(destination);
  await act(async () => { callbacks.get("tauri://drag-drop")!({ payload: { position: { x: 60, y: 80 }, paths } }); });
}

it("moves a remote file from root into a folder and refreshes the listing", async () => {
  const { panel } = await setup();
  drag(panel, row("note.txt"), row("folder"));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_rename", {
    sessionId: "session", oldPath: "/note.txt", newPath: "/folder/note.txt",
  }));
  await waitFor(() => expect(screen.queryByText("note.txt")).toBeNull());
  expect(invoke).not.toHaveBeenCalledWith("sftp_upload", expect.anything());
});
it("supports nested folder targets and moving a folder back to the root breadcrumb", async () => {
  const { panel } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "展开 folder" }));
  await screen.findByText("nested");
  drag(panel, row("nested"), screen.getByRole("button", { name: "/", exact: true }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_rename", {
    sessionId: "session", oldPath: "/folder/nested", newPath: "/nested",
  }));
});
it("does not move a folder into itself or its descendants", async () => {
  const { panel } = await setup();
  fireEvent.click(screen.getByRole("button", { name: "展开 folder" }));
  await screen.findByText("nested");
  drag(panel, row("folder"), row("folder"));
  drag(panel, row("folder"), row("nested"));
  expect(await screen.findByText("不能将文件夹移动到自身或其子目录中。")).toBeTruthy();
  expect(invoke).not.toHaveBeenCalledWith("sftp_rename", expect.anything());
});
it("rejects same-name moves without overwriting the target", async () => {
  const { panel } = await setup();
  listing["/folder"].push({ ...file, path: "/folder/note.txt" });
  drag(panel, row("note.txt"), row("folder"));
  await screen.findByText(/目标目录已存在/);
  expect(invoke).not.toHaveBeenCalledWith("sftp_rename", expect.anything());
});
it("ignores clicks, same-directory drops, outside drops and canceled drags", async () => {
  const { panel } = await setup();
  const source = row("note.txt");
  hitTest.mockReturnValue(row("folder"));
  fireEvent.pointerDown(source, { button: 0, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(source, { clientX: 10, clientY: 10 });
  drag(panel, source, screen.getByRole("button", { name: "/", exact: true }));
  drag(panel, source, document.body);
  fireEvent.pointerDown(source, { button: 0 });
  fireEvent.pointerMove(panel, { clientX: 30, clientY: 40 });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(panel, { clientX: 30, clientY: 40 });
  expect(invoke).not.toHaveBeenCalledWith("sftp_rename", expect.anything());
});
it("uploads to the hovered nested folder using scaled native coordinates", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "展开 folder" }));
  await screen.findByText("nested");
  const target = screen.getByTitle("nested");
  hitTest.mockReturnValue(target);
  act(() => callbacks.get("tauri://drag-over")!({ payload: { position: { x: 60, y: 80 } } }));
  expect(row("nested").getAttribute("data-sftp-drop-active")).toBe("true");
  await nativeDrop(target);
  expect(hitTest).toHaveBeenCalledWith(30, 40);
  expect(invoke).toHaveBeenCalledWith("sftp_list", { sessionId: "session", path: "/folder/nested" });
  expect(invoke).toHaveBeenCalledWith("sftp_upload", {
    sessionId: "session", localPath: "C:\\upload.txt", remotePath: "/folder/nested/upload.txt", transferId: "transfer",
  });
});
it("uploads panel whitespace to the current directory and ignores drops outside", async () => {
  const { panel } = await setup();
  await nativeDrop(panel);
  expect(invoke).toHaveBeenCalledWith("sftp_upload", expect.objectContaining({ remotePath: "/upload.txt" }));
  vi.mocked(invoke).mockClear();
  await nativeDrop(document.body);
  expect(invoke).not.toHaveBeenCalled();
});
it("checks upload conflicts in the target folder and honors cancellation", async () => {
  await setup();
  listing["/folder"].push({ name: "upload.txt", path: "/folder/upload.txt", isDir: false });
  vi.spyOn(window, "confirm").mockReturnValue(false);
  await nativeDrop(row("folder"));
  expect(window.confirm).toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalledWith("sftp_upload", expect.anything());
});
it("clears native hover feedback on leave and unregisters listeners", async () => {
  const { unmount } = await setup();
  hitTest.mockReturnValue(row("folder"));
  act(() => callbacks.get("tauri://drag-enter")!({ payload: { position: { x: 60, y: 80 } } }));
  expect(row("folder").getAttribute("data-sftp-drop-active")).toBe("true");
  act(() => callbacks.get("tauri://drag-leave")!({ payload: null }));
  expect(row("folder").hasAttribute("data-sftp-drop-active")).toBe(false);
  unmount();
  expect(callbacks.size).toBe(0);
});

it("keeps the upload destination when navigation changes during the conflict check", async () => {
  await setup();
  let finishListing!: (value: typeof file[]) => void;
  const originalInvoke = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args: any) => {
    if (command === "sftp_list" && args.path === "/folder")
      return new Promise((resolve) => { finishListing = resolve; });
    return originalInvoke(command, args);
  });
  hitTest.mockReturnValue(row("folder"));
  act(() => callbacks.get("tauri://drag-drop")!({ payload: {
    position: { x: 60, y: 80 }, paths: ["C:\\one.txt", "C:\\two.txt"],
  } }));
  fireEvent.change(screen.getByLabelText("远程路径"), { target: { value: "/elsewhere" } });
  fireEvent.click(screen.getByRole("button", { name: "前往", exact: true }));
  await waitFor(() => expect(screen.getByRole("button", { name: "elsewhere", exact: true })).toBeTruthy());
  await act(async () => { finishListing([]); });
  for (const name of ["one.txt", "two.txt"]) {
    expect(invoke).toHaveBeenCalledWith("sftp_upload", expect.objectContaining({ remotePath: `/folder/${name}` }));
  }
});

it("reports failed remote moves and keeps the source visible", async () => {
  const { panel } = await setup();
  const originalInvoke = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command, args) => command === "sftp_rename"
    ? Promise.reject(new Error("Permission denied")) : originalInvoke(command, args));
  drag(panel, row("note.txt"), row("folder"));
  await screen.findByText(/Permission denied/);
  expect(row("note.txt")).toBeTruthy();
});
