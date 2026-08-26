import { createRoot } from "react-dom/client";
import App from "./App";
import "./style.css";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

// 原型 demo 不用 StrictMode：其双挂载会让 window.__term 指向已 dispose 的终端实例
createRoot(rootEl).render(<App />);
