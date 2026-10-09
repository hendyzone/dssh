import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "./ui/button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { markdownImagePath, type WebPage } from "../lib/webPages";
import "./WebPageView.css";

function MarkdownImage({ source, alt, page }: { source?: string; alt?: string; page: WebPage }) {
  const [data, setData] = useState<string>();
  const [failed, setFailed] = useState(false);
  const path = source && page.target.kind !== "url" ? markdownImagePath(source, page.target.path) : null;
  const external = source && /^https?:\/\//i.test(source) ? source : undefined;
  useEffect(() => {
    let disposed = false;
    setData(undefined); setFailed(false);
    if (path) void invoke<string>("sftp_read_image", { sessionId: page.sessionId, path })
      .then(value => { if (!disposed) setData(value); })
      .catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; };
  }, [path, page.sessionId]);
  if (failed || (!path && !external)) return <span>[图片无法加载：{alt || source}]</span>;
  if (!data && !external) return <span>[图片加载中：{alt}]</span>;
  return <img src={data ?? external} alt={alt ?? ""} referrerPolicy="no-referrer" onError={() => setFailed(true)}/>;
}

export default function WebPageView({ page, active }: { page: WebPage; active: boolean }) {
  const [revision, setRevision] = useState(0);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => {
    if (page.target.kind === "url") return;
    let disposed = false;
    setHtml(null);
    setError(null);
    invoke<string>(page.target.kind === "image" ? "sftp_read_image" : "sftp_read_text", { sessionId: page.sessionId, path: page.target.path })
      .then(text => { if (!disposed) setHtml(text); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [page, revision]);
  const address = page.target.kind !== "url" ? page.target.path : page.target.url;
  return <section className="session-body web-page" hidden={!active} aria-label={`网页 ${page.title}`}>
    <div className="web-page-toolbar">
      <Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>刷新网页</Button>
      {page.target.kind === "image" && <Button variant="outline" size="sm" onClick={() => setActualSize(value => !value)}>{actualSize ? "适应窗口" : "原始尺寸"}</Button>}
      <span title={address}>{address}</span>
    </div>
    <p className="web-page-hint">{page.target.kind === "html"
      ? "远程 HTML 预览 · 支持 1 MB 以内的 UTF-8 单文件页面；同目录图片、CSS 等资源暂不加载。"
      : page.target.kind === "markdown" ? "Markdown 预览 · 支持 1 MB 以内的 UTF-8 文档及文档中的相对路径图片。"
      : page.target.kind === "image" ? "图片预览 · 支持 20 MB 以内的 PNG、JPEG、GIF、WebP、BMP、SVG、ICO、AVIF。"
      : "部分网站禁止内嵌显示；若无法加载，可在系统浏览器中打开。"}
      {page.target.kind === "url" && <Button variant="ghost" size="sm" onClick={() => {
        void invoke("taskboard_open", { url: address }).catch(reason => setError(String(reason)));
      }}>在系统浏览器打开</Button>}
    </p>
    {error && <p role="alert">网页打开失败：{error}</p>}
    {page.target.kind !== "url" && html === null && !error && <p role="status">正在读取远程文件…</p>}
    {page.target.kind === "markdown" && html !== null && <article className="markdown-preview" key={revision}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
        img: ({ src, alt }) => <MarkdownImage source={src} alt={alt} page={page}/>,
        a: ({ href, children }) => <a href={href} onClick={event => {
          event.preventDefault();
          if (href && /^https?:\/\//i.test(href)) void invoke("taskboard_open", { url: href }).catch(reason => setError(String(reason)));
        }}>{children}</a>,
      }}>{html}</ReactMarkdown>
    </article>}
    {page.target.kind === "image" && html !== null && !error && <div className={`web-page-image${actualSize ? " actual-size" : ""}`}>
      <img src={html} alt={page.title} onError={() => setError("图片损坏或当前系统不支持此格式")}/>
    </div>}
    {(page.target.kind === "url" || (page.target.kind === "html" && html !== null)) && <iframe
      key={revision}
      title={page.title}
      sandbox="allow-scripts allow-forms allow-downloads"
      referrerPolicy="no-referrer"
      src={page.target.kind === "url" ? page.target.url : undefined}
      srcDoc={page.target.kind === "html" ? html ?? undefined : undefined}
    />}
  </section>;
}
