import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ServerForm from "../src/components/ServerForm";

vi.mock("../src/platform/core", () => ({
  invoke: vi.fn().mockResolvedValue([]),
}));
vi.mock("../src/platform/dialog", () => ({ open: vi.fn() }));

const server = {
  id: "server-1",
  name: "测试",
  host: "example.com",
  port: 22,
  username: "root",
  authMethod: "password" as const,
};

async function setup(
  onSubmit = vi.fn().mockResolvedValue(undefined),
  initial = server,
) {
  const onCancel = vi.fn();
  const result = render(
    <ServerForm initial={initial} onSubmit={onSubmit} onCancel={onCancel} />,
  );
  await act(async () => {});
  const form = document.querySelector("form")!;
  return { ...result, onSubmit, onCancel, form };
}

describe("server input", () => {
  it("keeps keyboard focus inside the dialog", async () => {
    await setup();
    const first = screen.getByLabelText("名称（可空）");
    const last = screen.getByRole("button", { name: "关闭" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it.each(["1", "65535"])("accepts valid boundary port %s", async (port) => {
    const { form, onSubmit } = await setup();
    fireEvent.change(screen.getByLabelText("端口 *"), {
      target: { value: port },
    });
    await act(async () => fireEvent.submit(form));
    expect(onSubmit.mock.calls[0][0].port).toBe(Number(port));
  });

  it.each(["", "0", "65536", "1.5", "1e2"])(
    "explains invalid port %s and focuses it",
    async (port) => {
      const { form, onSubmit } = await setup();
      const input = screen.getByLabelText("端口 *");
      fireEvent.change(input, { target: { value: port } });
      fireEvent.submit(form);
      expect(onSubmit).not.toHaveBeenCalled();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(document.activeElement).toBe(input);
      expect(screen.getByText(/1.*65535.*整数/)).toBeTruthy();
    },
  );

  it("requires a key path for private key authentication", async () => {
    const { form, onSubmit } = await setup();
    fireEvent.change(screen.getByLabelText("认证方式"), {
      target: { value: "publicKey" },
    });
    await act(async () => {});
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("请填写或选择私钥路径")).toBeTruthy();
  });

  it("blocks IME Enter default submission and submit during composition", async () => {
    const { form, onSubmit } = await setup();
    const input = screen.getByLabelText("名称（可空）");
    fireEvent.compositionStart(input);
    const allowed = fireEvent.keyDown(input, {
      key: "Enter",
      isComposing: true,
      keyCode: 229,
    });
    expect(allowed).toBe(false);
    fireEvent.submit(form);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    await act(async () => fireEvent.submit(form));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("locks repeat saves and cancel while pending", async () => {
    let resolve!: () => void;
    const submit = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { form, onCancel, container } = await setup(submit);
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(
      (screen.getByRole("button", { name: "保存中…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByLabelText("地址 *").matches(":disabled")).toBe(true);
    fireEvent.click(document.querySelector('[data-slot="dialog-overlay"]')!);
    fireEvent.keyDown(form, { key: "Escape" });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => resolve());
  });

  it("keeps values and reports save failure for retry", async () => {
    // A rejected native save must stay inside the form, not become an unhandled promise.
    const submit = vi
      .fn()
      .mockRejectedValueOnce("钥匙串不可用")
      .mockResolvedValueOnce(undefined);
    const { form } = await setup(submit);
    await act(async () => fireEvent.submit(form));
    expect(screen.getByRole("alert").textContent).toContain("钥匙串不可用");
    expect((screen.getByLabelText("地址 *") as HTMLInputElement).value).toBe(
      "example.com",
    );
    await act(async () => fireEvent.submit(form));
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0].id).toBe(submit.mock.calls[1][0].id);
  });

  it("keeps a new server ID stable when retrying a failed save", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce("暂时不可用")
      .mockResolvedValue(undefined);
    const { container } = render(
      <ServerForm onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("地址 *"), {
      target: { value: "example.com" },
    });
    const form = document.querySelector("form")!;
    await act(async () => fireEvent.submit(form));
    await act(async () => fireEvent.submit(form));
    expect(onSubmit.mock.calls[0][0].id).toBe(onSubmit.mock.calls[1][0].id);
  });

  it("normalizes generated names and preserves saved metadata and credentials", async () => {
    const initial = {
      ...server,
      name: "",
      host: " example.com ",
      username: " root ",
      hasPassword: true,
      forwards: [],
    };
    const { form, onSubmit } = await setup(
      vi.fn().mockResolvedValue(undefined),
      initial,
    );
    await act(async () => fireEvent.submit(form));
    expect(onSubmit.mock.calls[0][0]).toEqual({
      ...initial,
      host: "example.com",
      username: "root",
      name: "root@example.com",
      group: undefined,
      keyPath: undefined,
    });
    expect(onSubmit.mock.calls[0][1]).toBeUndefined();
  });
});
