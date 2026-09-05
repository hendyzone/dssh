import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ImagePreview from "./components/ImagePreview";
import "./ui.css";
import "./style.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// 预览窗口以 index.html#/preview/{id} 打开，复用同一前端包
const previewMatch = location.hash.match(/^#\/preview\/(.+)$/);

createRoot(rootEl).render(
  <StrictMode>
    {previewMatch ? <ImagePreview id={previewMatch[1]} /> : <App />}
  </StrictMode>,
);
