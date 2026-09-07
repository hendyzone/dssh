import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ServerImport from "../src/components/ServerImport";
import { parseServerImport } from "../src/lib/serverImport";
import { upsertServer } from "../src/store";
import { invoke } from "../src/platform/core";
vi.mock("../src/platform/core", () => ({ invoke: vi.fn() }));

vi.mock("../src/store", () => ({ upsertServer: vi.fn() }));
vi.mock("../src/platform/dialog", () => ({ open: vi.fn() }));
const line =
  'host=example.com port=22 user=root authType=password password=synthetic=a title="测试  主机"';

describe("SSH import", () => {
  it("saves pasted keys once per identity and passes only paths to connection storage", async () => {
    vi.mocked(invoke)
      .mockReset()
      .mockResolvedValue("C:/app/imported-keys/key-test");
    vi.mocked(upsertServer)
      .mockReset()
      .mockImplementation(async (record) => record);
    render(
      <ServerImport servers={[]} onImported={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("连接文本"), {
      target: {
        value:
          "host=one.example user=u authType=identity identityId=test\nhost=two.example user=u authType=identity identityId=test",
      },
    });
    fireEvent.click(screen.getByText("预览导入"));
    fireEvent.click(screen.getByRole("button", { name: "粘贴私钥" }));
    fireEvent.change(screen.getByLabelText("身份 test正文"), {
      target: { value: "synthetic-private-key" },
    });
    fireEvent.change(screen.getByLabelText("身份 test口令"), {
      target: { value: "synthetic-passphrase" },
    });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "导入 2 个连接" }));
    await waitFor(() => expect(upsertServer).toHaveBeenCalledTimes(2));
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      "servers_import_private_key",
      { content: "synthetic-private-key", passphrase: "synthetic-passphrase" },
    );
    for (const call of vi.mocked(upsertServer).mock.calls) {
      expect(call[0].keyPath).toBe("C:/app/imported-keys/key-test");
      expect(call[2]).toBe("synthetic-passphrase");
      expect(JSON.stringify(call[0])).not.toContain("synthetic-private-key");
    }
    vi.mocked(upsertServer).mockReset();
  });
  it("does not import a connection when pasted key validation fails", async () => {
    vi.mocked(invoke)
      .mockReset()
      .mockRejectedValue(new Error("private diagnostic"));
    vi.mocked(upsertServer).mockReset();
    render(
      <ServerImport servers={[]} onImported={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("连接文本"), {
      target: { value: "host=one.example user=u authType=privateKey" },
    });
    fireEvent.click(screen.getByText("预览导入"));
    fireEvent.click(screen.getByRole("button", { name: "粘贴私钥" }));
    fireEvent.change(screen.getByLabelText("默认私钥正文"), {
      target: { value: "invalid-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个连接" }));
    await waitFor(() => expect(screen.getByText(/私钥未能保存/)).toBeTruthy());
    expect(upsertServer).not.toHaveBeenCalled();
    expect(screen.queryByText("private diagnostic")).toBeNull();
  });
  it("preserves quoted Unicode titles, equals signs and Windows key paths", () => {
    const rows = parseServerImport(
      line +
        '\r\nhost=key.example user=ubuntu authType=privateKey keyPath="C:\\keys\\id_ed25519"',
    );
    expect(rows[0].record?.name).toBe("测试  主机");
    expect(rows[0].password).toBe("synthetic=a");
    expect(rows[1].record).toMatchObject({
      port: 22,
      authMethod: "publicKey",
      keyPath: "C:\\keys\\id_ed25519",
    });
    expect(rows[0].record).not.toHaveProperty("password");
  });
  it("recognizes identities without inventing key material", () => {
    const row = parseServerImport(
      "host=test.example user=user authType=identity identityId=external-test",
    )[0];
    expect(row.identityId).toBe("external-test");
    expect(row.record?.keyPath).toBeUndefined();
    expect(row.record?.authMethod).toBe("publicKey");
  });
  it.each([
    "port=0",
    "port=65536",
    "port=1.2",
    "user=",
    "authType=other",
    'title="unclosed',
    "unknown=secret",
    "host=again",
  ])("rejects malformed input without echoing secrets: %s", (suffix) => {
    const row = parseServerImport(line + " " + suffix)[0];
    expect(row.error).toBeTruthy();
    expect(row.error).not.toContain("synthetic");
    expect(row.record).toBeUndefined();
  });
  it("ignores blank lines and comments and keeps source line numbers", () => {
    expect(parseServerImport("\n# comment\n" + line)[0].line).toBe(3);
  });
  it("imports sequentially, skips duplicates, hides passwords, and retries only failures", async () => {
    const save = vi.mocked(upsertServer);
    save
      .mockImplementationOnce(async (record) => ({
        ...record,
        hasPassword: true,
      }))
      .mockRejectedValueOnce(new Error("private diagnostic"))
      .mockImplementation(async (record) => record);
    render(
      <ServerImport servers={[]} onImported={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("连接文本"), {
      target: {
        value: [line, line, line.replace("user=root", "user=other")].join("\n"),
      },
    });
    fireEvent.click(screen.getByText("预览导入"));
    expect(screen.queryByText(/synthetic/)).toBeNull();
    expect(screen.getByText("重复连接，跳过")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "导入 2 个连接" }));
    await waitFor(() =>
      expect(screen.getByText("保存失败，可重试")).toBeTruthy(),
    );
    expect(save).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("private diagnostic")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个连接" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save.mock.calls[2][0].username).toBe("other");
    expect(save.mock.calls[0][1]).toBe("synthetic=a");
  });
  it("requires identity mapping before import and shares it across matching identities", () => {
    render(
      <ServerImport servers={[]} onImported={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("连接文本"), {
      target: {
        value:
          "host=one.example user=u authType=identity identityId=external-test\nhost=two.example user=u authType=identity identityId=external-test",
      },
    });
    fireEvent.click(screen.getByText("预览导入"));
    expect(screen.getAllByText("待选择私钥")).toHaveLength(2);
    fireEvent.change(
      screen.getByRole("textbox", { name: "身份 external-test" }),
      { target: { value: "C:\\keys\\test" } },
    );
    expect(
      screen
        .getByRole("button", { name: "导入 2 个连接" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });
});
