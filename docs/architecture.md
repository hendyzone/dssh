# dssh 架构设计

## 总览

```
┌─ 桌面壳：Tauri v2（Rust + Web 前端，macOS/Windows 单包分发）
│
├─ 前端（React + TypeScript + Vite）
│   ├─ 侧边栏：服务器列表 / 分组 / 搜索
│   ├─ 主区：多标签 + 分屏终端（ghostty-web，Canvas 渲染器）
│   ├─ SFTP 文件面板
│   ├─ 端口转发管理面板
│   └─ 服务器监控小面板
│
├─ Rust 后端（Tauri commands）
│   ├─ russh：SSH 连接、shell 会话、SFTP、端口转发
│   └─ keyring：系统安全存储凭据（Keychain / Credential Manager）
│
└─ 主题系统：配色方案 + 字体 + 透明度
```

## 关键技术选型

### 终端内核：ghostty-web（Kitty graphics 支持版）

**核心矛盾**：主流 Web 终端组件 xterm.js 不支持 Kitty graphics protocol（其 image addon 仅支持 iTerm2 IIP / Sixel）。而 pi 等工具在现代终端中优先使用 Kitty 协议显示图片。

- 上游 `ghostty-web`（npm: `ghostty-web`，coder/ghostty-web）：xterm.js 兼容 API，但 Kitty graphics 未完整接入
- **选用 fork：`github:rcarmo/ghostty-web`**（v0.9.6，dist 已预编译，无需 Zig 即可安装）
  - Kitty graphics 已在 Canvas 渲染器中完整接入（placement 合成、PNG 解码）
  - 保留 xterm.js 兼容 API（`Terminal` / `FitAddon` / `onData` / `write`）
  - WebGL 渲染器暂不支持 Kitty graphics → **固定使用 Canvas 渲染器**

**待验证风险**（M0 demo 的核心目的）：

1. Kitty graphics 的**能力探测查询**（APC query）能否正确应答——pi 据此决定是否发送图片；若 WASM 层不应答，需在集成层拦截查询序列并代答
2. 经 SSH 传输后图片序列的完整性
3. 长时间会话渲染稳定性

### 桌面壳：Tauri v2（而非 Electron）

- 体积小（~10MB vs ~150MB）、内存低、原生系统能力（keychain、窗口）
- 代价：前端跑在系统 WebView（macOS WKWebView / Windows WebView2），ghostty-web 的 WASM + Canvas 在两者中均可运行，但需实测 WKWebView 表现

### SSH 层：russh（纯 Rust SSH 库）

- shell 交互会话、SFTP 子系统、tcpip-forward / direct-tcpip 全支持
- 与 Tauri 后端同进程，字节流通过 Tauri event 推给前端终端组件

### 凭据存储：keyring crate

- macOS Keychain / Windows Credential Manager，不落盘明文

## 数据流（终端会话）

```
远程主机 ←SSH→ russh（Rust） ←Tauri event/invoke→ 前端 ←→ ghostty-web（WASM 解析 + Canvas 渲染）
```

键盘输入经 ghostty-web `onData` → Tauri invoke → russh channel 写入；输出反向。
Kitty keyboard protocol 的启用标志位由 ghostty-web 输入层处理（M0 验证）。

## 仓库结构

```
dssh/
├── docs/                  # 本文档与需求文档
├── prototypes/
│   └── kitty-image/       # M0 验证 demo（Vite + ghostty-web + node ws/pty）
└── apps/
    └── desktop/           # Tauri 桌面应用
        ├── src/           # React 前端
        └── src-tauri/     # Rust 后端
```

## 备选方案（若 ghostty-web 验证失败）

回退到 xterm.js + xterm-addon-image，接受图片协议降级（仅 iTerm2 IIP / Sixel），
pi 在不支持 Kitty 的终端下会探测降级，图片功能将打折扣或不可用。
