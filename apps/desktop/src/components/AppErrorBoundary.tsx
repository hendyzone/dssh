import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

export default class AppErrorBoundary extends Component<{children:ReactNode}, {error:Error | null}> {
  state: {error:Error | null} = {error:null};
  static getDerivedStateFromError(error:Error) { return {error}; }
  componentDidCatch(error:Error, info:ErrorInfo) {
    void invoke("desktop_report_error", {message:error.message,stack:info.componentStack}).catch(() => {});
  }
  render() {
    if (!this.state.error) return this.props.children;
    return <main role="alert" style={{padding:32,color:"#e2e8f0",background:"#1a1b26",minHeight:"100vh"}}>
      <h1>界面出现异常</h1>
      <p>可以打开开发者工具查看错误，或重启应用。重启会断开当前 SSH 连接。</p>
      <pre style={{whiteSpace:"pre-wrap",userSelect:"text"}}>{this.state.error.message}</pre>
      <button onClick={() => void invoke("desktop_devtools")}>打开开发者工具</button>{" "}
      <button onClick={() => void invoke("desktop_restart")}>重启应用</button>
    </main>;
  }
}
