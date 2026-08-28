# 同类软件功能调研

> 目的：为 dssh 的功能取舍提供参照。调研对象：Xterminal（直接对标）、Tabby、WindTerm、electerm（主流开源）、Termius / Warp / iTerm2（商业与设计标杆）。
> 来源：各项目官网 / GitHub README / 官方文档，2026-08 调研。

## 一、功能矩阵

| 功能域 | Xterminal | Tabby | WindTerm | electerm | Termius | iTerm2 |
| --- | --- | --- | --- | --- | --- | --- |
| **连接与会话管理** |
| 服务器列表/分组/搜索 | ✅ 分组 | ✅ 连接管理器 | ✅ 会话树 | ✅ 分组 | ✅ Hosts+分组 | ✅ Profiles |
| 密码/密钥自动登录 | ✅ | ✅ 加密凭据容器 | ✅ 密码/公钥/kbd-int/GSSAPI | ✅ publicKey+password | ✅ | ✅ 密码管理器 |
| 导入 ssh_config | — | ✅ | ✅ | ✅ | ✅ | — |
| 跳板机 / ProxyJump | ✅ | ✅ 自动管理跳转主机 | ✅ ProxyCommand/ProxyJump | ✅ | ✅ | — |
| SSH Agent / Agent 转发 | — | ✅ | ✅ | ✅ | ✅ | — |
| 登录后自动执行命令/脚本 | — | ✅ Login scripts | ✅ 认证后自动执行 | ✅ | — | — |
| 断线自动重连 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| **终端体验** |
| 多标签 / 分屏 | ✅ | ✅ 嵌套分屏、任意侧标签 | ✅ 分屏视图 | ✅ | ✅ | ✅ |
| 配色 / 主题 / 字体 | ✅ | ✅ 大量配色+连字 | ✅ vscode 风格配色 | ✅ 主题+背景图 | ✅ | ✅ |
| 窗口透明度 | — | ✅ | ✅ | ✅ | — | ✅ |
| 终端内搜索/高亮 | ✅ | ✅ | ✅ 搜索+标记+预览 | ✅ | ✅ | ✅ 正则搜索 |
| 复制即选 / 右键粘贴 | — | ✅ 可选 | ✅ | ✅ | — | ✅ |
| 多行粘贴警告 / bracketed paste | — | ✅ | ✅ 粘贴对话框 | — | — | ✅ |
| 全局热键呼出窗口 (Quake) | — | ✅ | — | ✅ `ctrl+2` | — | ✅ Hotkey Window |
| 进程完成通知 | — | ✅ | — | — | — | ✅ |
| 命令面板 (Command Palette) | — | ✅ | ✅ | — | — | ✅ Toolbelt |
| 触发器 (Triggers)/自动响应 | — | 插件 | — | — | — | ✅ |
| 终端内图片 (Kitty/Sixel) | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ 自家协议 |
| **文件传输** |
| SFTP 面板 | ✅ 编辑/删除/上传下载/移动、书签 | ✅ SFTP 面板 | ✅ 集成 SFTP/SCP + 本地文件管理器 | ✅ | ✅ 双栏 | ❌ |
| 拖拽上传 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| 双击编辑远程小文件 | — | — | — | ✅ | — | — |
| Zmodem (rz/sz) / Trzsz | — | ✅ Zmodem | ✅ X/Y/ZModem | ✅ Zmodem+Trzsz | — | ✅ |
| **网络** |
| 端口转发 local/remote/dynamic | ✅ | ✅ | ✅ | ✅ | ✅ 可视化管理 | — |
| X11 转发 | — | ✅ | ✅ | — | — | — |
| 全局/会话代理 | ✅ | ✅ | ✅ | ✅ | — | — |
| **监控与其他** |
| 服务器监控 (CPU/内存/磁盘) | ✅ 图表化实时监控 | ❌ | ❌ | ✅ | ❌ | — |
| 快捷命令 / Snippets | ✅ | 插件 | ✅ Quick Bar | ✅ | ✅ | — |
| 批量输入到多会话 | — | ✅ | ✅ Sync Input | ✅ | — | — |
| 会话日志记录 | — | ✅ | ✅ | ✅ | — | ✅ |
| 配置云同步 | ✅ | ✅ 加密同步 | — | ✅ gist/webdav/云 | ✅ E2E 加密同步 | — |
| AI 助手 | ✅ AI 提示/解答/补全 | 插件 | — | ✅ AI + MCP | ✅ 自动补全 | ❌ |
| 其他协议 (Telnet/Serial/RDP/VNC) | 本地控制台 | Telnet/Serial | Telnet/Serial/RawTcp | Telnet/Serial/RDP/VNC/Spice/FTP | Mosh | — |
| tmux 集成 | — | — | ✅ tmux integration | — | — | ✅ tmux -CC |

## 二、各家值得注意的设计点

**Xterminal（直接对标）**

- 卖点是"监控图表 + 简易文件管理 + AI 提示"，功能面并不宽，dssh 现有 P0 已覆盖其主体。
- 致命短板（用户实测）：莫名黑屏、界面老旧。dssh 的差异化正是**稳定 + 好看 + Kitty 图片**。

**Tabby**

- "记标签、嵌套分屏、多行粘贴警告、进程完成通知、登录脚本"都是低成本高体验的项。
- 加密凭据容器 + 配置同步是其架构亮点；dssh 用系统 keyring 已解决凭据部分。

**WindTerm（功能最全的开源参照）**

- 几乎把 SSH 客户端做全了：ProxyJump、agent 转发、X11、tmux 集成、命令面板、快速栏、自由输入模式。
- 但 UI 是 Qt 传统桌面风格，且 2023 后更新放缓 —— "功能全但不好看"正是 dssh 的机会窗口。

**electerm**

- 双击直接编辑远程小文件、Trzsz（兼容 tmux 的 rz/sz）、透明窗口/背景图、批量输入。
- 功能铺得过广（RDP/VNC/Spice/Serial），个人项目不应模仿其广度。

**Termius / Warp / iTerm2**

- Termius：Snippets、shell 集成自动补全、E2E 加密同步 —— 商业化的"省心"体验。
- Warp：blocks、命令面板、AI —— 交互范式先进但重，不适合 dssh 抄。
- iTerm2：Triggers、语义历史、Hotkey Window、tmux -CC —— 是 dssh "好看"部分的直接参照系。

## 三、对 dssh 的启示

1. **P0 清单已被验证是对的**：七项刚需在 Xterminal 上全部存在且被高频使用，不必扩。
2. **低成本高体验的短板项**（竞品普遍有、dssh 未列）：终端内搜索、复制即选/右键粘贴、多行粘贴警告、断线自动重连、导入 ssh_config、登录后自动执行命令 —— 建议提为 P1。
3. **图片协议是独家差异点**：六款对标产品仅 iTerm2 支持终端图片（且是自家私有协议，不兼容 Kitty）。Kitty graphics 在 GUI SSH 客户端里基本是空白，值得作为核心卖点投入。
4. **要抵制的诱惑**：多协议（RDP/VNC/Serial）、AI 助手、云同步、批量群发 —— electerm/Termius 证明这些会把产品做重，与个人自用定位冲突。
