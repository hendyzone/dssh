import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { useWindowClose } from "../src/lib/useWindowClose";
const mock = vi.hoisted(() => ({
  listen: vi.fn(),
  destroy: vi.fn(),
  confirm: vi.fn(),
  off: vi.fn(),
  handler: null as
    | null
    | ((e: { preventDefault: () => void }) => Promise<void>),
}));
vi.mock("../src/platform/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: mock.listen,
    destroy: mock.destroy,
  }),
}));
vi.mock("../src/platform/dialog", () => ({ confirm: mock.confirm }));
beforeEach(() => {
  mock.handler = null;
  mock.listen.mockImplementation(async (handler) => {
    mock.handler = handler;
    return mock.off;
  });
  mock.destroy.mockResolvedValue(undefined);
  mock.confirm.mockResolvedValue(true);
});
async function close() {
  const event = { preventDefault: vi.fn() };
  await act(async () => {
    await mock.handler!(event);
  });
  expect(event.preventDefault).toHaveBeenCalled();
}
test("without sessions, a close request destroys the window without a dialog", async () => {
  renderHook(() => useWindowClose(false));
  await close();
  expect(mock.destroy).toHaveBeenCalledTimes(1);
  expect(mock.confirm).not.toHaveBeenCalled();
});
test("reads current sessions, supports cancellation, and closes after confirmation", async () => {
  const view = renderHook(({ active }) => useWindowClose(active), {
    initialProps: { active: false },
  });
  view.rerender({ active: true });
  mock.confirm.mockResolvedValueOnce(false);
  await close();
  expect(mock.destroy).not.toHaveBeenCalled();
  await close();
  expect(mock.destroy).toHaveBeenCalledTimes(1);
  expect(mock.listen).toHaveBeenCalledTimes(1);
});
test("repeated title-bar clicks do not open duplicate confirmation dialogs", async () => {
  let resolve!: (value: boolean) => void;
  mock.confirm.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  renderHook(() => useWindowClose(true));
  let first!: Promise<void>;
  act(() => {
    first = mock.handler!({ preventDefault: vi.fn() });
  });
  await close();
  expect(mock.confirm).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolve(true);
    await first;
  });
  expect(mock.destroy).toHaveBeenCalledTimes(1);
});
test("reports a close failure and permits retry", async () => {
  mock.destroy.mockRejectedValueOnce("permission denied");
  const { result } = renderHook(() => useWindowClose(false));
  await close();
  expect(result.current).toContain("permission denied");
  await close();
  expect(result.current).toBeNull();
  expect(mock.destroy).toHaveBeenCalledTimes(2);
});
test("late registration and pending confirmations cannot close an unmounted window", async () => {
  let resolveOff!: (off: () => void) => void;
  mock.listen.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolveOff = r;
      }),
  );
  const first = renderHook(() => useWindowClose(false));
  first.unmount();
  await act(async () => resolveOff(mock.off));
  expect(mock.off).toHaveBeenCalledTimes(1);
  let resolve!: (value: boolean) => void;
  mock.confirm.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const second = renderHook(() => useWindowClose(true));
  let pending!: Promise<void>;
  act(() => {
    pending = mock.handler!({ preventDefault: vi.fn() });
  });
  second.unmount();
  await act(async () => {
    resolve(true);
    await pending;
  });
  expect(mock.destroy).not.toHaveBeenCalled();
});
test("a registration failure is visible", async () => {
  mock.listen.mockRejectedValueOnce("event listener failed");
  const { result } = renderHook(() => useWindowClose(false));
  await waitFor(() =>
    expect(result.current).toContain("event listener failed"),
  );
});
