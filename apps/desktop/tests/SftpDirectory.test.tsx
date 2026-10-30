import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import SftpPanel from "../src/components/SftpPanel";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../src/lib/transfers", () => ({ subscribeTransfers: () => () => {}, createTransfer: () => "transfer", waitForTransferListener: async () => {}, formatTransferSize: () => "", transferPercent: () => 0 }));
beforeEach(() => {
  vi.mocked(invoke).mockImplementation(async command => command === "sftp_home" ? "/home/demo" : []);
});
const props = (paneId: string, tmuxSessionName?: string, serverId = "server") => ({ sessionId: `ssh-${paneId}`, serverId, paneId, tmuxSessionName, onClose: () => {} });
async function at(path: string) {
  await waitFor(() => expect((screen.getByLabelText("远程路径") as HTMLInputElement).value).toBe(path));
}
async function navigate(path: string) {
  fireEvent.change(screen.getByLabelText("远程路径"), { target: { value: path } });
  fireEvent.click(screen.getByRole("button", { name: "前往" }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_list", expect.objectContaining({ path })));
  await act(async () => {});
}
it("isolates two tmux sessions on one server and restores by name after remount/reconnect", async () => {
  const a = render(<SftpPanel {...props("tmux-a", "alpha")} />);
  await at("/home/demo"); await navigate("/tmp/x"); a.unmount();
  const b = render(<SftpPanel {...props("tmux-b", "beta")} />);
  await at("/home/demo"); await navigate("/tmp/y"); b.unmount();
  const again = render(<SftpPanel {...props("new-backend", "alpha")} />);
  await at("/tmp/x"); again.unmount();
  render(<SftpPanel {...props("tmux-c", "alpha", "other-server")} />);
  await at("/home/demo");
});
it("remembers ordinary panes across panel remount/reconnect without persisting or sharing", async () => {
  const a = render(<SftpPanel {...props("plain-a")} />);
  await at("/home/demo"); await navigate("/plain/a"); a.unmount();
  const b = render(<SftpPanel {...props("plain-b")} />);
  await at("/home/demo"); await navigate("/plain/b"); b.unmount();
  render(<SftpPanel {...props("plain-a")} sessionId="reconnected" />);
  await at("/plain/a");
  expect(Object.keys(localStorage).filter(key => key.startsWith("dssh.sftp.last-directory"))).toEqual([]);
});
it("ignores legacy server storage and starts from this terminal cwd without following later cd", async () => {
  localStorage.setItem("dssh.sftp.last-directory.server", "/another/session");
  const view = render(<SftpPanel {...props("fresh", "fresh")} terminalCwd="/own/cwd" />);
  await at("/own/cwd");
  expect(invoke).not.toHaveBeenCalledWith("sftp_list", expect.objectContaining({ path: "/another/session" }));
  await navigate("/chosen");
  view.rerender(<SftpPanel {...props("fresh", "fresh")} terminalCwd="/later/cwd" />);
  await at("/chosen");
});
it("falls back from an inaccessible saved directory to cwd then home", async () => {
  const view = render(<SftpPanel {...props("fallback", "fallback")} />);
  await at("/home/demo"); await navigate("/gone"); view.unmount();
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "sftp_home") return "/home/demo";
    if (command === "sftp_list" && args.path !== "/home/demo") throw new Error("not found");
    return [];
  });
  render(<SftpPanel {...props("fallback-new", "fallback")} terminalCwd="/also-gone" />);
  await at("/home/demo");
  for (const path of ["/gone", "/also-gone"]) expect(invoke).toHaveBeenCalledWith("sftp_list", { sessionId: "ssh-fallback-new", path });
});
it("does not let a late response from the previous session overwrite the new session", async () => {
  let finish!: (value: unknown[]) => void;
  vi.mocked(invoke).mockImplementation(async (command, args: any) => {
    if (command === "sftp_home") return "/home/demo";
    if (command === "sftp_list" && args.sessionId === "ssh-slow") return new Promise(resolve => { finish = resolve; });
    return [];
  });
  const view = render(<SftpPanel {...props("slow", "slow")} terminalCwd="/slow" />);
  await waitFor(() => expect(finish).toBeTruthy());
  view.rerender(<SftpPanel {...props("fast", "fast")} terminalCwd="/fast" />);
  await at("/fast");
  await act(async () => finish([]));
  await at("/fast"); view.unmount();
  render(<SftpPanel {...props("fast-again", "fast")} />);
  await at("/fast");
});
