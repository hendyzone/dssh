# dssh

个人自用的现代化 SSH 客户端。功能对标 Xterminal，目标是**稳定**（不黑屏）和**好看**（iTerm2 风格），并支持终端内图片显示（Kitty graphics protocol，兼容 pi 等现代终端工具）。

- 平台：macOS / Windows
- 技术栈：Tauri v2 + React + [ghostty-web](https://github.com/rcarmo/ghostty-web)（Kitty graphics fork）+ russh

## 功能（v0.2.0）

- ✅ 服务器列表：分组 / 搜索 / 编辑，凭据存系统 keyring
- ✅ SSH 终端：自动登录（密码/私钥）、多标签页、水平/垂直分屏、中文输入
- ✅ 终端内图片：Kitty graphics 协议（pi 等工具直接内联显示），双击图片弹预览窗
- ✅ SFTP 文件面板：浏览 / 拖拽上传 / 下载 / 新建目录 / 删除 / 重命名
- ✅ 端口转发：本地 / 远程 / 动态 SOCKS5
- ✅ 服务器监控条：CPU / 内存 / 磁盘 / 负载
- ✅ 主题：4 套预设热切换 + 字号 / 字体设置

## 文档

- [需求文档](docs/requirements.md)
- [架构设计](docs/architecture.md)

## 目录

| 路径 | 说明 |
|------|------|
| `prototypes/kitty-image` | M0 验证 demo：终端图片协议可行性 |
| `apps/desktop` | Tauri 桌面应用（主项目） |

## 快速开始（验证 demo）

```bash
cd prototypes/kitty-image
npm install
npm run dev        # 同时启动前端 Vite 与后端 ws+pty
# 打开 http://localhost:5173，点 "发送测试图片" 或运行 pi 验证图片显示
```
