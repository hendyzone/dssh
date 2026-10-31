import { invoke } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ImagePreview from "./components/ImagePreview";
import DetachedTabWindow from "./components/DetachedTabWindow";
import OfficeWindow from "./components/OfficeWindow";
import AppErrorBoundary from "./components/AppErrorBoundary";
import { installDiagnostics } from "./lib/diagnostics";
import "./ui.css";
import "./style.css";

const disposeDiagnostics = location.hash === "#/office" ? () => {} : installDiagnostics();
if (import.meta.hot) import.meta.hot.dispose(disposeDiagnostics);
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// 预览窗口以 index.html#/preview/{id} 打开，复用同一前端包
const detachedMatch = location.hash.match(/^#\/detached\/([a-f0-9]+)$/);
const previewMatch = location.hash.match(/^#\/preview\/(.+)$/);

const mount=()=>createRoot(rootEl).render(
  <StrictMode>
    {detachedMatch ? <AppErrorBoundary><DetachedTabWindow id={detachedMatch[1]}/></AppErrorBoundary> : location.hash === "#/office" ? <AppErrorBoundary><OfficeWindow /></AppErrorBoundary> : previewMatch ? <ImagePreview id={previewMatch[1]} /> : <AppErrorBoundary><App /></AppErrorBoundary>}
  </StrictMode>,
);

if(detachedMatch || previewMatch || location.hash==="#/office")mount();
else void invoke("tab_main_mount").then(mount).catch(error=>{rootEl.textContent=`工作现场恢复失败，请重新打开窗口：${String(error)}`;});
