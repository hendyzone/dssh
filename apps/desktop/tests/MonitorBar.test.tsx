import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import MonitorBar from "../src/components/MonitorBar";
import type { MonitorStats } from "../src/lib/monitor";
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (e: { payload: unknown }) => void>(),
  off: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
const fixture: MonitorStats = {
  cpuPct: 20,
  cpus: [{ name: "cpu0", pct: 20 }],
  memory: {
    total: 1024,
    used: 512,
    available: 512,
    cached: 200,
    swapTotal: 0,
    swapUsed: 0,
  },
  loads: [1, 2, 3],
  uptime: 86400,
  os: "Ubuntu test",
  kernel: "6.8",
  hostname: "server-a",
  networks: [
    { name: "eth0", received: 100, sent: 200, receiveRate: 10, sendRate: 20 },
  ],
  disks: [
    {
      device: "/dev/sda1",
      fsType: "ext4",
      mount: "/",
      total: 1000,
      used: 200,
      available: 800,
      pct: 20,
    },
  ],
  diskIo: [{ name: "sda", readRate: 100, writeRate: 200 }],
  processes: [
    { pid: 10, cpu: 5, mem: 1, command: "node worker" },
    { pid: 20, cpu: 1, mem: 5, command: "postgres" },
  ],
  processesAvailable: true,
};
beforeEach(() => {
  mocks.handlers.clear();
  mocks.invoke.mockResolvedValue(undefined);
  mocks.listen.mockImplementation(async (name, handler) => {
    mocks.handlers.set(name, handler);
    return mocks.off;
  });
});
async function start() {
  fireEvent.click(screen.getByRole("button", { name: "开启监控" }));
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "monitor_start",
      expect.anything(),
    ),
  );
}
function emit(suffix: string, payload: unknown, session = "a") {
  const key = [...mocks.handlers.keys()].find(
    (k) => k.startsWith(`monitor://${session}/`) && k.endsWith(suffix),
  );
  if (!key) throw new Error("Listener missing");
  act(() => mocks.handlers.get(key)!({ payload }));
}
test("subscribes before starting, displays resources and filters/sorts processes", async () => {
  mocks.invoke.mockImplementation(async (name) => {
    if (name === "monitor_start") expect(mocks.handlers.size).toBe(2);
  });
  render(<MonitorBar backendId="a" />);
  await start();
  emit("/stats", fixture);
  expect(screen.getByText("Ubuntu test")).toBeTruthy();
  expect(screen.getByText("eth0")).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "进程排序" }), {
    target: { value: "mem" },
  });
  const processRows = screen
    .getByText("postgres")
    .closest("tbody")!
    .querySelectorAll("tr");
  expect(processRows[0].textContent).toContain("postgres");
  fireEvent.change(screen.getByRole("textbox", { name: "搜索进程" }), {
    target: { value: "node" },
  });
  expect(screen.queryByText("postgres")).toBeNull();
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(screen.queryByRole("region", { name: "服务器监控详情" })).toBeNull();
});
test("switching sessions immediately clears data and ignores late events", async () => {
  const view = render(<MonitorBar backendId="a" />);
  await start();
  emit("/stats", fixture);
  view.rerender(<MonitorBar backendId="b" />);
  expect(screen.queryByText("Ubuntu test")).toBeNull();
  emit("/stats", fixture);
  expect(screen.queryByText("Ubuntu test")).toBeNull();
  await waitFor(() =>
    expect(mocks.invoke).toHaveBeenCalledWith(
      "monitor_start",
      expect.objectContaining({ sessionId: "b" }),
    ),
  );
  expect(mocks.invoke).toHaveBeenCalledWith(
    "monitor_stop",
    expect.objectContaining({ sessionId: "a" }),
  );
});
test("errors mark previous data stale and retry starts a new collector", async () => {
  render(<MonitorBar backendId="a" />);
  await start();
  emit("/stats", fixture);
  emit("/error", "采集超时");
  expect(screen.getByRole("alert").textContent).toContain("采集超时");
  expect(screen.getByText(/数据已过期/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() =>
    expect(
      mocks.invoke.mock.calls.filter((c) => c[0] === "monitor_start"),
    ).toHaveLength(2),
  );
  expect(screen.queryByText("Ubuntu test")).toBeNull();
});
test("late subscription is disposed without starting a stopped monitor", async () => {
  let resolve!: (off: () => void) => void;
  mocks.listen.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = render(<MonitorBar backendId="a" />);
  fireEvent.click(screen.getByRole("button", { name: "开启监控" }));
  view.unmount();
  await act(async () => resolve(mocks.off));
  expect(mocks.off).toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
test("disconnected sessions cannot start monitoring", () => {
  render(<MonitorBar backendId={null} />);
  expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});
