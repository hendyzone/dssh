import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import TerminalView from "../src/components/TerminalView";

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(),
  instances: [] as any[],
}));
vi.mock("../src/platform/core", () => ({ invoke: mocks.invoke }));
vi.mock("../src/platform/event", () => ({
  listen: mocks.listen,
}));
vi.mock("ghostty-web/ghostty-vt.wasm?url", () => ({ default: "test.wasm" }));
vi.mock("ghostty-web", () => ({
  init: mocks.init,
  FitAddon: class {
    observeResize() {}
    fit() {}
  },
  Terminal: class {
    options: any;
    root?: HTMLElement;
    data?: (text: string) => void;
    handler?: (event: KeyboardEvent) => boolean | undefined;
    cols = 80;
    rows = 24;
    constructor(options: any) {
      this.options = options;
      mocks.instances.push(this);
    }
    loadAddon() {}
    open(root: HTMLElement) {
      this.root = root;
      root.contentEditable = "true";
      root.setAttribute("tabindex", "0");
      root.innerHTML =
        '<textarea aria-label="Terminal input"></textarea><canvas></canvas>';
      root
        .querySelector("textarea")!
        .addEventListener("paste", () => this.data?.("pasted text"));
      // The real library focuses on open, including a deferred backup focus.
      this.focus();
    }
    focus() {
      this.root?.focus();
      setTimeout(() => this.root?.focus(), 0);
    }
    write = vi.fn();
    getSelection = vi.fn(() => "selected terminal text");
    hasMouseTracking = vi.fn(() => false);
    paste = vi.fn();
    selectAll = vi.fn();
    attachCustomKeyEventHandler(
      handler: (event: KeyboardEvent) => boolean | undefined,
    ) {
      this.handler = handler;
    }
    onData(callback: (text: string) => void) {
      this.data = callback;
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
    onRender() {
      return { dispose() {} };
    }
    dispose() {}
  },
}));

const props = {
  session: {
    id: "pane",
    server: {
      id: "server",
      name: "server",
      host: "example.com",
      port: 22,
      username: "root",
      authMethod: "password" as const,
    },
  },
  active: true,
  inputEnabled: true,
  settings: { themeId: "tokyo-night", fontSize: 14, fontFamily: "monospace" },
  onBackendReady: vi.fn(),
};

beforeEach(() => {
  mocks.instances.length = 0;
  mocks.init.mockResolvedValue(undefined);
  mocks.listen.mockResolvedValue(() => {});
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "ssh_connect" ? "backend" : undefined,
  );
});

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
  });
};

it("confirms Shift selection only after clipboard write succeeds and dismisses the notice", async () => {
  let complete!: () => void;
  const writeText = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<TerminalView {...props} />);
  await settle();
  expect(mocks.instances[0].options.copyOnSelect).toBe(false);
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.mouseDown(canvas, { button: 0, shiftKey: true });
  fireEvent.mouseUp(document, { button: 0, shiftKey: true });
  expect(writeText).toHaveBeenCalledWith("selected terminal text");
  expect(screen.getByRole("status").textContent).toContain("正在复制");
  expect(screen.queryByText(/已复制到本机剪贴板/)).toBeNull();
  vi.useFakeTimers();
  try {
    await act(async () => complete());
    expect(screen.getByRole("status").textContent).toContain("已复制到本机剪贴板");
    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText(/已复制到本机剪贴板/)).toBeNull();
  } finally { view.unmount(); vi.useRealTimers(); Reflect.deleteProperty(navigator, "clipboard"); }
});

it("shows selection copy failure without claiming success", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  const view = render(<TerminalView {...props} />); await settle();
  const canvas = view.container.querySelector("canvas")!;
  fireEvent.mouseDown(canvas, { button: 0, shiftKey: true });
  await act(async () => fireEvent.mouseUp(document, { button: 0 }));
  expect(screen.getByRole("alert").textContent).toContain("复制失败");
  expect(screen.queryByText(/已复制到本机剪贴板/)).toBeNull();
  Reflect.deleteProperty(navigator, "clipboard");
});

it("keeps double-click copying and refreshes the notice for repeated identical copies", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<TerminalView {...props} />); await settle();
  const canvas = view.container.querySelector("canvas")!;
  vi.useFakeTimers();
  try {
    await act(async () => fireEvent.click(canvas, { button: 0, detail: 2 }));
    act(() => vi.advanceTimersByTime(3000));
    await act(async () => fireEvent.click(canvas, { button: 0, detail: 2 }));
    expect(writeText).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status").textContent).toContain("已复制到本机剪贴板");
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.queryByText(/已复制到本机剪贴板/)).toBeNull();
  } finally { view.unmount(); vi.useRealTimers(); Reflect.deleteProperty(navigator, "clipboard"); }
});

it("does not copy empty selections or mouse-tracked terminal clicks", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const view = render(<TerminalView {...props} />); await settle();
  const canvas = view.container.querySelector("canvas")!;
  mocks.instances[0].getSelection.mockReturnValue("");
  fireEvent.mouseDown(canvas, { button: 0, shiftKey: true }); fireEvent.mouseUp(document, { button: 0 });
  mocks.instances[0].getSelection.mockReturnValue("old selection");
  mocks.instances[0].hasMouseTracking.mockReturnValue(true);
  fireEvent.mouseDown(canvas, { button: 0 }); fireEvent.mouseUp(document, { button: 0 });
  expect(writeText).not.toHaveBeenCalled();
  Reflect.deleteProperty(navigator, "clipboard");
});

it("replaces canvas browser menus and pastes through terminal bracketed-paste handling", async () => {
  const readText = vi.fn().mockResolvedValue("synthetic paste");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText, writeText: vi.fn().mockResolvedValue(undefined) },
  });
  const view = render(<TerminalView {...props} />);
  await settle();
  const canvas = view.container.querySelector("canvas")!;
  const nativeHandler = vi.fn();
  canvas.addEventListener("contextmenu", nativeHandler);
  fireEvent.contextMenu(canvas, { clientX: 30, clientY: 30 });
  expect(nativeHandler).not.toHaveBeenCalled();
  expect(screen.getByRole("menu", { name: "终端操作" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "粘贴" }));
  await settle();
  expect(mocks.instances[0].paste).toHaveBeenCalledWith("synthetic paste");
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.contextMenu(canvas);
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  Reflect.deleteProperty(navigator, "clipboard");
});

it("focuses the hidden textarea when a pane becomes active", async () => {
  const view = render(<TerminalView {...props} active={false} />);
  await settle();
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  view.rerender(<TerminalView {...props} />);
  await settle();
  expect(document.activeElement).toBe(screen.getByLabelText("Terminal input"));
  other.remove();
});

it("late background initialization cannot steal focus", async () => {
  let ready!: () => void;
  mocks.init.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  );
  const view = render(<TerminalView {...props} />);
  view.rerender(<TerminalView {...props} active={false} />);
  const other = document.createElement("input");
  document.body.append(other);
  other.focus();
  await act(async () => ready());
  await settle();
  expect(document.activeElement).toBe(other);
  expect(mocks.instances[0].options.cursorBlink).toBe(false);
  other.remove();
});

it("opening a dialog suspends terminal input and closing it restores focus", async () => {
  const view = render(<TerminalView {...props} />);
  await settle();
  screen.getByLabelText("Terminal input").focus();
  view.rerender(<TerminalView {...props} inputEnabled={false} />);
  await settle();
  expect(document.activeElement).not.toBe(
    screen.getByLabelText("Terminal input"),
  );
  mocks.invoke.mockClear();
  fireEvent.paste(screen.getByLabelText("Terminal input"));
  expect(mocks.invoke).not.toHaveBeenCalled();
  view.rerender(<TerminalView {...props} />);
  await settle();
  expect(document.activeElement).toBe(screen.getByLabelText("Terminal input"));
});

it("continues sending protocol replies for background and dialog-covered terminals", async () => {
  const view = render(<TerminalView {...props} />);
  await settle();
  view.rerender(
    <TerminalView {...props} active={false} inputEnabled={false} />,
  );
  mocks.invoke.mockClear();
  mocks.instances[0].data("\x1b[1;1R");
  expect(mocks.invoke).toHaveBeenCalledWith("ssh_write", {
    sessionId: "backend",
    data: "\x1b[1;1R",
  });
});

it("does not restart an SSH session when only focus changes", async () => {
  const view = render(<TerminalView {...props} />);
  await settle();
  view.rerender(<TerminalView {...props} active={false} />);
  view.rerender(<TerminalView {...props} />);
  await settle();
  expect(
    mocks.invoke.mock.calls.filter(([command]) => command === "ssh_connect"),
  ).toHaveLength(1);
});

it("shows connecting only as transient UI, never in terminal history", async () => {
  let connected!: (value: string) => void;
  mocks.invoke.mockImplementation((command: string) =>
    command === "ssh_connect"
      ? new Promise<string>((resolve) => {
          connected = resolve;
        })
      : Promise.resolve(),
  );
  render(<TerminalView {...props} />);
  await settle();
  expect(screen.getByRole("status").textContent).toContain("正在连接");
  await act(async () => connected("backend"));
  expect(screen.queryByRole("status")).toBeNull();
  expect(mocks.instances[0].write.mock.calls.flat().join("")).not.toContain(
    "正在连接",
  );
});

it("subscribes to output before injecting the directory hook", async () => {
  let output: ((event: { payload: string }) => void) | undefined;
  mocks.listen.mockImplementation(
    async (event: string, callback: typeof output) => {
      if (event.endsWith("/data")) output = callback;
      return () => {};
    },
  );
  let subscribedAtWrite = false;
  mocks.invoke.mockImplementation(
    async (command: string, args?: { data: string }) => {
      if (command === "ssh_connect") return "backend";
      if (command === "ssh_write" && args?.data.includes("__dssh_osc7")) {
        subscribedAtWrite = Boolean(output);
        const marker = args.data.match(/dssh-init-[a-f0-9-]+/)?.[0];
        output?.({
          payload:
            args.data.replace(/.{95}/g, "$&\r\n") +
            `\x1b]1337;${marker}\x07` +
            "ready$ ",
        });
      }
    },
  );
  render(<TerminalView {...props} />);
  await settle();
  expect(subscribedAtWrite).toBe(true);
  const visible = mocks.instances[0].write.mock.calls.flat().join("");
  expect(visible).not.toContain("__dssh_osc7");
  expect(visible).toContain("ready$ ");
});

it("starts tmux only after subscribing and never types a shell hook into its pane", async () => {
  const tmux = { id: "$2", created: 123, name: "work" };
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "ssh_connect") return "backend";
    if (command === "ssh_start")
      expect(mocks.listen.mock.calls.map((c) => c[0])).toEqual([
        "ssh://backend/exit",
        "ssh://backend/data",
      ]);
  });
  render(<TerminalView {...props} session={{ ...props.session, tmux }} />);
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith(
    "ssh_connect",
    expect.objectContaining({
      params: expect.objectContaining({ tmux: { id: "$2", created: 123 } }),
    }),
  );
  expect(
    mocks.invoke.mock.calls.filter((c) => c[0] === "ssh_write"),
  ).toHaveLength(0);
  expect(screen.queryByRole("status")).toBeNull();
});
it("reattaches the same tmux identity on manual reconnect without shell injection", async () => {
  let exit!: (event: { payload: number }) => void;
  mocks.listen.mockImplementation(
    async (name: string, handler: typeof exit) => {
      if (name.endsWith("/exit")) exit = handler;
      return () => {};
    },
  );
  render(
    <TerminalView
      {...props}
      session={{
        ...props.session,
        tmux: { id: "$2", created: 123, name: "work" },
      }}
    />,
  );
  await settle();
  act(() => exit({ payload: 0 }));
  fireEvent.click(screen.getByRole("button", { name: /点此重连/ }));
  await settle();
  const calls = mocks.invoke.mock.calls.filter((c) => c[0] === "ssh_connect");
  expect(calls).toHaveLength(2);
  expect(calls[1][1].params.tmux).toEqual({ id: "$2", created: 123 });
  expect(
    mocks.invoke.mock.calls.filter((c) => c[0] === "ssh_write"),
  ).toHaveLength(0);
});

it("automatically recovers network loss but does not reattach after an intentional detach", async () => {
  let exit!: (event: { payload: number }) => void;
  mocks.listen.mockImplementation(
    async (name: string, handler: typeof exit) => {
      if (name.endsWith("/exit")) exit = handler;
      return () => {};
    },
  );
  const view = render(
    <TerminalView
      {...props}
      session={{
        ...props.session,
        tmux: { id: "$2", created: 123, name: "work" },
      }}
    />,
  );
  await settle();
  vi.useFakeTimers();
  try {
    act(() => exit({ payload: -1 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "ssh_connect"),
    ).toHaveLength(2);
    act(() => exit({ payload: 0 }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "ssh_connect"),
    ).toHaveLength(2);
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});

it("uploads a clipboard screenshot and inserts only its remote path", async () => {
  const png = {size:8,arrayBuffer:async()=>new Uint8Array([137,80,78,71,13,10,26,10]).buffer};
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{read:vi.fn().mockResolvedValue([{types:["image/png"],getType:async()=>png}])}});
  mocks.invoke.mockImplementation(async(command:string)=>command === "ssh_connect" ? "backend" : command === "sftp_clipboard_image" ? "/home/demo/.dssh-image-test/screenshot.png" : undefined);
  const view=render(<TerminalView {...props}/>); await settle();
  fireEvent.contextMenu(view.container.querySelector("canvas")!);
  fireEvent.click(screen.getByRole("menuitem",{name:"粘贴截图（上传到远程）"})); await settle();
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_clipboard_image",{sessionId:"backend",data:[137,80,78,71,13,10,26,10]});
  expect(mocks.instances[0].paste).toHaveBeenCalledWith('"/home/demo/.dssh-image-test/screenshot.png" ');
  Reflect.deleteProperty(navigator,"clipboard");
});

it("copies the latest tmux buffer to the local clipboard on an explicit menu action",async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined);
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
 mocks.invoke.mockImplementation(async(command:string)=>command === "ssh_connect" ? "backend" : command === "tmux_copy_buffer" ? "中文 buffer\n" : undefined);
 const view=render(<TerminalView {...props}/>);await settle();
 fireEvent.contextMenu(view.container.querySelector("canvas")!);
 fireEvent.click(screen.getByRole("menuitem",{name:"复制 tmux 最近内容到本机"}));await settle();
 expect(mocks.invoke).toHaveBeenCalledWith("tmux_copy_buffer",{sessionId:"backend"});
 expect(writeText).toHaveBeenCalledWith("中文 buffer\n");
 Reflect.deleteProperty(navigator,"clipboard");
});

it("Ctrl Shift C fetches tmux text only when no local selection exists",async()=>{
 const writeText=vi.fn().mockResolvedValue(undefined);
 Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
 mocks.invoke.mockImplementation(async(command:string)=>command === "ssh_connect" ? "backend" : command === "tmux_copy_buffer" ? "remote selection" : undefined);
 const view=render(<TerminalView {...props}/>);await settle();
 mocks.instances[0].getSelection.mockReturnValue("");
 fireEvent.keyDown(view.container.querySelector("canvas")!,{key:"C",ctrlKey:true,shiftKey:true});await settle();
 expect(writeText).toHaveBeenCalledWith("remote selection");
 Reflect.deleteProperty(navigator,"clipboard");
});
