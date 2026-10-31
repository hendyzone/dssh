import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Alert } from "./ui/alert";
import { createTransfer, waitForTransferListener } from "../lib/transfers";
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

export default function WebPageView({ page, active, onStatus, restricted=false }: { page: WebPage; active: boolean; onStatus?: (status:string)=>void; restricted?:boolean }) {
  const statusRef=useRef(onStatus);statusRef.current=onStatus;
  const [revision, setRevision] = useState(0);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const downloadBusy = useRef(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const download = async () => {
    if (page.target.kind === "url" || downloadBusy.current) return;
    downloadBusy.current = true;
    setDownloading(true);
    setDownloadError(null);
    setDownloadPath(null);
    try {
      const remotePath = page.target.path;
      const transferId = createTransfer(page.sessionId, remotePath.split("/").pop() || remotePath, "download");
      await waitForTransferListener(page.sessionId);
      const localPath = await invoke<string>("sftp_download", {
        sessionId: page.sessionId,
        remotePath,
        transferId,
      });
      setDownloadPath(localPath);
    } catch (reason) {
      setDownloadError(String(reason));
    } finally {
      downloadBusy.current = false;
      setDownloading(false);
    }
  };

  useEffect(() => {
    if (page.target.kind === "url") return;
    let disposed = false;
    setHtml(null);
    setError(null);
    invoke<string>(page.target.kind === "image" ? "sftp_read_image" : "sftp_read_text", { sessionId: page.sessionId, path: page.target.path })
      .then(text => { if (!disposed) {setHtml(text);if(page.target.kind==="markdown")statusRef.current?.("connected");} })
      .catch(reason => { if (!disposed) {setError(String(reason));statusRef.current?.("disconnected");} });
    return () => { disposed = true; };
  }, [page, revision]);
  const address = page.target.kind !== "url" ? page.target.path : page.target.url;
  return <section className="session-body web-page" hidden={!active} aria-label={`网页 ${page.title}`}>
    <div className="web-page-toolbar">
      <Button variant="outline" size="sm" onClick={() => setRevision(value => value + 1)}>刷新网页</Button>
      {page.target.kind === "image" && <Button variant="outline" size="sm" onClick={() => setActualSize(value => !value)}>{actualSize ? "适应窗口" : "原始尺寸"}</Button>}
      {!restricted && page.target.kind !== "url" && <Button variant="outline" size="sm" disabled={downloading} onClick={() => void download()}>{downloading ? "下载中…" : "下载"}</Button>}
      <span title={address}>{address}</span>
    </div>
    <p className="web-page-hint">{page.target.kind === "html"
      ? "远程 HTML 预览 · 支持 1 MB 以内的 UTF-8 单文件页面；同目录图片、CSS 等资源暂不加载。"
      : page.target.kind === "markdown" ? "Markdown 预览 · 支持 1 MB 以内的 UTF-8 文档及文档中的相对路径图片。"
      : page.target.kind === "image" ? "图片预览 · 支持 20 MB 以内的 PNG、JPEG、GIF、WebP、BMP、SVG、ICO、AVIF。"
      : "部分网站禁止内嵌显示；若无法加载，可在系统浏览器中打开。"}
      {!restricted && page.target.kind === "url" && <Button variant="ghost" size="sm" onClick={() => {
        void invoke("taskboard_open", { url: address }).catch(reason => setError(String(reason)));
      }}>在系统浏览器打开</Button>}
    </p>
    {downloadError && <Alert variant="destructive" className="block">{downloadError}</Alert>}
    {downloadPath && <Alert role="status" className="block">
      <div>
        <span>已下载到 {downloadPath}</span>
        <Button variant="outline" size="sm" onClick={() => {
          void invoke("sftp_reveal_local", { path: downloadPath })
            .catch(reason => setDownloadError(`无法打开所在目录：${String(reason)}`));
        }}>打开所在目录</Button>
        <Button variant="ghost" size="sm" onClick={() => setDownloadPath(null)}>关闭提示</Button>
      </div>
    </Alert>}
    {error && <p role="alert">网页打开失败：{error}</p>}
    {page.target.kind !== "url" && html === null && !error && <p role="status">正在读取远程文件…</p>}
    {page.target.kind === "markdown" && html !== null && <article className="markdown-preview" key={revision}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
        img: ({ src, alt }) => <MarkdownImage source={src} alt={alt} page={page}/>,
        a: ({ href, children }) => <a href={href} onClick={event => {
          event.preventDefault();
          if (!restricted && href && /^https?:\/\//i.test(href)) void invoke("taskboard_open", { url: href }).catch(reason => setError(String(reason)));
        }}>{children}</a>,
      }}>{html}</ReactMarkdown>
    </article>}
    {page.target.kind === "image" && html !== null && !error && <div className={`web-page-image${actualSize ? " actual-size" : ""}`}>
      <img src={html} alt={page.title} onLoad={()=>statusRef.current?.("connected")} onError={() => {setError("图片损坏或当前系统不支持此格式");statusRef.current?.("disconnected");}}/>
    </div>}
    {(page.target.kind === "url" || (page.target.kind === "html" && html !== null)) && <iframe
      key={revision}
      title={page.title}
      onLoad={() => statusRef.current?.("connected")}
      onError={() => statusRef.current?.("disconnected")}
      sandbox="allow-scripts allow-forms allow-downloads"
      referrerPolicy="no-referrer"
      src={page.target.kind === "url" ? page.target.url : undefined}
      srcDoc={page.target.kind === "html" ? html ?? undefined : undefined}
    />}
  </section>;
}
