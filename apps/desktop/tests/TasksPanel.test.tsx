import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import TasksPanel from "../src/components/TasksPanel";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

it("only configures the selected provider on an explicit action and exposes uninstall", async () => {
  vi.mocked(invoke).mockResolvedValue({ message: "已接入，请重启工具" });
  render(<TasksPanel sessionId="ssh" serverName="Dev" onClose={() => {}} onSelect={() => {}} />);
  expect(invoke).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("接入 AI 状态 · Dev"));
  fireEvent.change(screen.getByLabelText("AI 工具"), { target: { value: "codex" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "接入", exact: true })));
  expect(invoke).toHaveBeenCalledWith("ai_setup", { sessionId: "ssh", provider: "codex", remove: false });
  expect(screen.getByRole("status").textContent).toContain("请重启工具");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "移除接入" })));
  expect(invoke).toHaveBeenLastCalledWith("ai_setup", { sessionId: "ssh", provider: "codex", remove: true });
});
