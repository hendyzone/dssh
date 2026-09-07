# Electron 迁移（v1.0.0）

桌面窗口统一使用 Electron 随包分发的 Chromium，移除 Tauri、WebView2 和 WKWebView 的运行时依赖。React 与 ghostty-web 继续承担界面和终端渲染；SSH、SFTP、tmux、监控、转发、凭据和加密同步复用现有 Rust 实现。

## 运行与构建

在 `apps/desktop` 执行 `npm ci`。需要 Node.js 22、Rust stable、本机 C/C++ 工具链；Windows 还需要 NASM 在 PATH 中。

- `npm run dev`：编译 Rust 后台、启动 Vite 和 Electron，退出时停止开发服务。
- `npm run build`：编译前端。
- `npm run build:backend`：生成 `backend/target/release/dssh-backend`（Windows 为 `.exe`）。
- `npm start`：运行已构建的前端和后台。
- `npm run pack`：生成 `release` 下的应用目录。
- `npm run dist`：生成当前平台安装包；Windows NSIS、macOS DMG/ZIP、Linux AppImage/DEB。
- `npm run test:smoke`：构建后运行真实 Electron / Rust / 本地 SSH 验证，使用临时配置，不接触用户连接或凭据；Linux 无桌面环境时使用 `xvfb-run --auto-servernum npm run test:smoke`。

CI 在三个系统各自编译后台和安装包，不跨平台复制本机二进制。分发签名证书尚未配置，正式发布前应在 CI 中配置 macOS / Windows 签名。

## 数据兼容

后台继续读取系统配置目录下的 `dev.dssh.app/servers.json`，并沿用原有 keyring 服务名。不会在启动时重写旧配置，既有私钥路径和完整加密同步格式保持兼容。

Electron 的 Chromium 用户数据与旧版 WebView 存储分开。旧版 `localStorage` 中的主题、字体、布局、最近连接等不会自动迁移；可先用旧版「设置 → 同步」做完整备份，再在新版恢复。恢复会按原有行为替换连接列表。未恢复时使用默认界面设置。

## 通信与安全边界

`src/platform` 提供 invoke、事件、文件对话框和窗口接口。预加载脚本通过 contextBridge 暴露有限接口；渲染进程开启 sandbox / contextIsolation，关闭 Node 集成。主进程验证请求来自自己的主框架和本地应用来源，图片预览窗口只能读取自己的图片及关闭自身。

主进程启动 Rust 子进程，通过私有 stdin/stdout 交换带请求 ID 的逐行 JSON，不监听 TCP 端口。命令白名单位于 `electron/commands.json`，Rust 分发位于 `backend/src/dispatch.rs`；新增后台命令需同时维护两处。终端输入按会话排队，事件在 preload 内同步订阅以避免开始输出前的订阅竞态。退出时结束后台，后台退出时拒绝待处理调用并标记终端断开。

文件拖放通过 Electron `webUtils.getPathForFile` 获取本地路径。剪贴板由统一 Chromium 的 Clipboard API 处理，主进程仅对主窗口授予剪贴板和通知权限。

安全设置参考 [Electron 官方安全指南](https://www.electronjs.org/docs/latest/tutorial/security) 与 [上下文隔离文档](https://www.electronjs.org/docs/latest/tutorial/context-isolation)。
