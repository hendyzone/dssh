import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import TmuxPanel from "../src/components/TmuxPanel";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), confirm: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mocks.confirm }));
const snapshot = {
  installed: true,
  version: "tmux 3.4",
  sessions: [{ id: "$0", name: "work", created: 123, windows: 1, attached: 1 }],
  panes: [
    {
      sessionId: "$0",
      windowId: "@0",
      windowIndex: 0,
      windowName: "editor",
      windowActive: true,
      id: "%0",
      index: 0,
      active: true,
      command: "vim",
      path: "/home/user",
      zoomed: false,
    },
  ],
};
beforeEach(() => {
  mocks.invoke.mockImplementation(async (command) =>
    command === "tmux_snapshot" ? snapshot : undefined,
  );
  mocks.confirm.mockResolvedValue(true);
});

test("background polling keeps the refresh button stable while manual refresh shows progress", async () => {
  vi.useFakeTimers();
  try {
    const view = render(
      <TmuxPanel sessionId="ssh" onAttach={() => {}} onClose={() => {}} />,
    );
    await act(async () => {});
    let resolveRead!: (value: typeof snapshot) => void;
    mocks.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve;
        }),
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    const button = screen.getByRole("button", {
      name: "刷新",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(screen.queryByText("读取中…")).toBeNull();
    await act(async () => resolveRead(snapshot));
    expect(button.textContent).toBe("刷新");
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "读取中…" })).toBeTruthy();
    await act(async () => resolveRead(snapshot));
    expect(button.textContent).toBe("刷新");
    view.unmount();
  } finally {
    vi.useRealTimers();
  }
});
test("discovers sessions and attaches by remote identity", async () => {
  const onAttach = vi.fn();
  render(<TmuxPanel sessionId="ssh" onAttach={onAttach} onClose={() => {}} />);
  await screen.findByText("work");
  fireEvent.click(screen.getByRole("button", { name: "进入会话" }));
  expect(onAttach).toHaveBeenCalledWith(snapshot.sessions[0]);
  expect(screen.getByText("0: vim ●")).toBeTruthy();
  onAttach.mockClear();
  fireEvent.doubleClick(screen.getByText("work"));
  expect(onAttach).toHaveBeenCalledWith(snapshot.sessions[0]);
});
test("creates named sessions and scopes pane actions without typing in SSH", async () => {
  render(<TmuxPanel sessionId="ssh" onAttach={() => {}} onClose={() => {}} />);
  await screen.findByText("work");
  fireEvent.click(screen.getByRole("button", { name: "新建会话" }));
  fireEvent.change(screen.getByLabelText("tmux 名称"), {
    target: { value: "background" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确定" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "tmux_action",
      expect.objectContaining({
        request: expect.objectContaining({
          action: "create-session",
          name: "background",
        }),
      }),
    ),
  );
  await waitFor(() => expect(screen.queryByLabelText("tmux 名称")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "左右分屏" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith("tmux_action", {
      sessionId: "ssh",
      request: {
        action: "split-horizontal",
        name: null,
        target: "%0",
        session: { id: "$0", created: 123 },
      },
    }),
  );
  expect(mocks.invoke.mock.calls.some((c) => c[0] === "ssh_write")).toBe(false);
});
test("canceling session termination never issues a destructive command", async () => {
  mocks.confirm.mockResolvedValue(false);
  render(<TmuxPanel sessionId="ssh" onAttach={() => {}} onClose={() => {}} />);
  await screen.findByText("work");
  fireEvent.click(screen.getByRole("button", { name: "结束会话" }));
  await act(async () => {});
  expect(mocks.confirm).toHaveBeenCalled();
  expect(mocks.invoke.mock.calls.some((c) => c[0] === "tmux_action")).toBe(
    false,
  );
});
test("shows missing tmux and fetch errors rather than an empty valid server", async () => {
  mocks.invoke.mockResolvedValueOnce({
    installed: false,
    version: "",
    sessions: [],
    panes: [],
  });
  const view = render(
    <TmuxPanel sessionId="ssh" onAttach={() => {}} onClose={() => {}} />,
  );
  await screen.findByText(/远端未找到 tmux/);
  mocks.invoke.mockRejectedValueOnce("SSH disconnected");
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).toContain("SSH disconnected");
  view.unmount();
});
