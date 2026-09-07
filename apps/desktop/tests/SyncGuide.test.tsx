import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { invoke } from "../src/platform/core";
import SettingsModal from "../src/components/SettingsModal";
vi.mock("../src/platform/core", () => ({ invoke: vi.fn() }));
function setup() {
  render(
    <SettingsModal
      settings={{ themeId: "nord", fontSize: 14, fontFamily: "monospace" }}
      onChange={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  fireEvent.mouseDown(screen.getByRole("tab", { name: "同步" }), { button: 0, ctrlKey: false });
}
it("explains preparation, credential limits and replacement before syncing", () => {
  setup();
  expect(screen.getByText("Contents: Read and write")).toBeTruthy();
  expect(screen.getByText(/SSH 密码、私钥文件及口令/)).toBeTruthy();
  expect(screen.getByText(/整体替换本机连接列表/)).toBeTruthy();
  expect(screen.queryByPlaceholderText("已保存（留空保持不变）")).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
it("accepts a repository URL and tests access without sending the encryption password", async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    fullName: "example/dssh-config",
    private: true,
  });
  setup();
  fireEvent.change(screen.getByLabelText("仓库地址或名称"), {
    target: { value: "https://github.com/example/dssh-config/" },
  });
  fireEvent.change(screen.getByLabelText("同步密码"), {
    target: { value: "synthetic-test-only" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith("sync_test", {
      repository: "example/dssh-config",
      pat: null,
    }),
  );
  expect(await screen.findByText(/连接成功/)).toBeTruthy();
});
it("rejects invalid repository text with an actionable example", () => {
  setup();
  fireEvent.change(screen.getByLabelText("仓库地址或名称"), {
    target: { value: "not a repository" },
  });
  fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
  expect(screen.getByText(/失败：请填写/)).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
});
