import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { markdownImagePath, selectedPage, type WebPage } from "../src/lib/webPages";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
import WebPageView from "../src/components/WebPageView";

beforeEach(() => mocks.invoke.mockReset());

it("recognizes the screenshot's remote HTML path and encoded Chinese filenames", () => {
  expect(selectedPage("file:///home/deng/.answer-me-with-html/pages/datrix-中枢-v2-核心机制-20261009-131637.html"))
    .toEqual({ kind: "html", path: "/home/deng/.answer-me-with-html/pages/datrix-中枢-v2-核心机制-20261009-131637.html" });
  expect(selectedPage(' "file:///home/deng/%E4%B8%AD%20%E6%96%87.htm" '))
    .toEqual({ kind: "html", path: "/home/deng/中 文.htm" });
  expect(selectedPage("/tmp/a.HTML")).toEqual({ kind: "html", path: "/tmp/a.HTML" });
  expect(selectedPage("https://example.com/page")).toEqual({ kind: "url", url: "https://example.com/page" });
});

it("rejects executable schemes, foreign file hosts and ambiguous selections", () => {
  for (const value of ["javascript:alert(1)", "data:text/html,test", "file://other/tmp/a.html",
    "/tmp/a.sh", "cat /tmp/a.html", "/a.html\n/b.html", "file:///a%00.html", "https://u:p@example.com"])
    expect(selectedPage(value)).toBeNull();
});

const page: WebPage = { id: "page", title: "图.html", sessionId: "ssh-original", target: { kind: "html", path: "/tmp/图.html" } };

it("recognizes Markdown and image paths and resolves document images remotely", () => {
  expect(selectedPage("file:///home/deng/说明.MD")).toEqual({ kind: "markdown", path: "/home/deng/说明.MD" });
  for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"])
    expect(selectedPage(`/tmp/图片.${ext}`)?.kind).toBe("image");
  expect(markdownImagePath("../assets/%E5%9B%BE.png", "/home/docs/readme.md")).toBe("/home/assets/图.png");
  expect(markdownImagePath("https://example.com/a.png", "/home/readme.md")).toBeNull();
  expect(markdownImagePath("//other/a.png", "/home/readme.md")).toBeNull();
  expect(markdownImagePath("a.html", "/home/readme.md")).toBeNull();
});

it("renders Markdown tables and relative images without executing raw HTML", async () => {
  mocks.invoke.mockImplementation(async (command: string) => command === "sftp_read_image"
    ? "data:image/png;base64,cGl4ZWw=" : "# 说明\n\n| 名称 | 状态 |\n| --- | --- |\n| 任务 | 完成 |\n\n![截图](images/a.png)\n\n<script>alert(1)</script>");
  const document: WebPage = { ...page, title: "说明.md", target: { kind: "markdown", path: "/tmp/说明.md" } };
  const view = render(<WebPageView page={document} active/>);
  expect(await screen.findByRole("heading", { name: "说明" })).toBeTruthy();
  expect(screen.getByRole("table").textContent).toContain("完成");
  expect(await screen.findByAltText("截图")).toBeTruthy();
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_read_image", { sessionId: "ssh-original", path: "/tmp/images/a.png" });
  expect(view.container.querySelector("script")).toBeNull();
});

it("previews binary images with original-size toggle, decoder error and refresh", async () => {
  mocks.invoke.mockResolvedValue("data:image/png;base64,cGl4ZWw=");
  render(<WebPageView page={{ ...page, title: "截图.png", target: { kind: "image", path: "/tmp/截图.png" } }} active/>);
  const image = await screen.findByAltText("截图.png");
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_read_image", { sessionId: "ssh-original", path: "/tmp/截图.png" });
  fireEvent.click(screen.getByText("原始尺寸"));
  expect(image.parentElement?.classList.contains("actual-size")).toBe(true);
  fireEvent.error(image);
  expect(screen.getByRole("alert").textContent).toContain("图片损坏");
  fireEvent.click(screen.getByText("刷新网页"));
  await screen.findByAltText("截图.png");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("loads via the source SSH session, isolates scripts and rereads on refresh", async () => {
  mocks.invoke.mockResolvedValue("<h1>图</h1><script>window.example=1</script>");
  const view = render(<WebPageView page={page} active/>);
  const frame = await screen.findByTitle("图.html");
  expect(mocks.invoke).toHaveBeenCalledWith("sftp_read_text", { sessionId: "ssh-original", path: "/tmp/图.html" });
  expect(frame.getAttribute("srcdoc")).toContain("<h1>图</h1>");
  expect(frame.getAttribute("sandbox")).toContain("allow-scripts");
  expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
  view.rerender(<WebPageView page={page} active={false}/>);
  expect(frame.closest("section")?.hidden).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  view.rerender(<WebPageView page={page} active/>);
  mocks.invoke.mockResolvedValue("<h1>更新</h1>");
  fireEvent.click(screen.getByText("刷新网页"));
  await waitFor(() => expect(screen.getByTitle("图.html").getAttribute("srcdoc")).toContain("更新"));
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
});

it("shows remote read errors and allows retry", async () => {
  mocks.invoke.mockRejectedValue("SSH 连接已断开");
  render(<WebPageView page={page} active/>);
  expect((await screen.findByRole("alert")).textContent).toContain("SSH 连接已断开");
  expect(screen.queryByTitle("图.html")).toBeNull();
  mocks.invoke.mockResolvedValue("<h1>恢复</h1>");
  fireEvent.click(screen.getByText("刷新网页"));
  await screen.findByTitle("图.html");
  expect(screen.queryByRole("alert")).toBeNull();
});
