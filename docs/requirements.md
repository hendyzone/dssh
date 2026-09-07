# dssh 需求文档

> 个人自用的现代化 SSH 客户端。起点：Xterminal 功能基本满足需求，但存在莫名黑屏（稳定性差）且界面丑。dssh 的目标是在覆盖同等功能的前提下做到**稳定**和**好看**。
>
> 功能取舍参照：[docs/competitor-survey.md](competitor-survey.md)（Xterminal / Tabby / WindTerm / electerm / Termius / iTerm2 调研）。
> 逐交互点的细化清单：[docs/feature-details.md](feature-details.md)（基于代码实际盘点的缺失项与缺陷）。

## 平台

- macOS + Windows（桌面 GUI 应用）
- 开发机在 Linux，构建/打包在目标平台进行

## 功能需求

### P0：对标 Xterminal 的刚需（v0.2.0 已交付 ✅）

| # | 功能 | 说明 |
| --- | --- | --- |
| 1 | 服务器列表 + 分组管理 | 服务器条目（名称/地址/端口/用户/认证方式），支持分组与搜索 |
| 2 | 密码/密钥自动登录 | 密码与私钥 passphrase 存系统安全存储（macOS Keychain / Windows Credential Manager） |
| 3 | 终端主题与配色自定义 | 配色方案、字体、字号、背景透明度等，风格对标 iTerm2 的简洁现代 |
| 4 | SFTP 文件管理 | 图形化文件面板，浏览/上传/下载，支持拖拽 |
| 5 | 端口转发 | local / remote / dynamic 三种，可视化管理与启停 |
| 6 | 多标签页 / 分屏 | 会话标签 + 窗格拆分 |
| 7 | 服务器状态监控 | CPU / 内存 / 磁盘等基础指标的小面板（SSH 定时轮询） |

### P1：竞品普遍具备的体验短板（下一批交付）

调研发现以下功能在 Tabby / WindTerm / electerm / Termius 中几乎是标配，成本不高但日常使用频率极高：

| # | 功能 | 说明 | 参照 |
| --- | --- | --- | --- |
| 8 | 终端内搜索 | 滚动缓冲区关键字搜索、高亮、上下跳转 | Tabby/WindTerm/iTerm2 均有 |
| 9 | 复制粘贴行为 | 复制即选（copy-on-select）、右键/中键粘贴可选、bracketed paste | Tabby/WindTerm |
| 10 | 多行粘贴警告 | 粘贴含换行的内容前弹确认，防误执行 | Tabby/iTerm2 |
| 11 | 断线检测与自动重连 | 心跳探测、断线提示、一键/自动重连（恢复会话现场） | 全线标配，与"稳定"定位直接相关 |
| 12 | 导入 ssh_config | 解析 `~/.ssh/config` 批量导入服务器条目（含 ProxyJump 字段） | Tabby/WindTerm/electerm |
| 13 | 登录后自动执行命令 | 服务器条目可配置认证后自动执行的命令（如 cd 到项目目录、进入 tmux） | Tabby login scripts / WindTerm |
| 14 | 跳板机 / ProxyJump | 条目级配置经跳板连接 | Tabby/WindTerm/Termius |
| 15 | 会话日志 | 可选将会话输出落盘（按会话/日期分文件），便于事后排查 | Tabby/WindTerm/electerm |

### P2：锦上添花（有空再做，按价值排序）

| # | 功能 | 说明 | 参照 |
| --- | --- | --- | --- |
| 16 | 命令面板 | ⌘P / ⌘⇧P 呼出，快速跳转服务器/切换标签/执行操作 | Tabby/WindTerm |
| 17 | 双击编辑远程小文件 | SFTP 面板双击小文件，本地编辑后自动回传 | electerm |
| 18 | 全局热键呼出窗口 | Quake 风格全局热键显隐主窗口 | Tabby/electerm/iTerm2 |
| 19 | 进程完成通知 | 长任务结束（铃声/BEL 或长时间无输出后返回）时系统通知 | Tabby/iTerm2 |
| 20 | 快捷命令片段 | 常用命令片段库，一键发送到当前会话（原"明确不做"项，调研后降级为 P2——实现量小、Xterminal/Termius 均证明高频） | Xterminal/Termius |
| 21 | SSH Agent 转发 | 会话级开关 | Tabby/WindTerm |
| 22 | URL/路径识别 | 终端输出中的 URL 可点击、文件路径可定位 | iTerm2 语义历史 |
| 23 | 窗口/标签页状态恢复 | 重启应用后恢复上次的标签与会话布局 | Tabby "remembers your tabs" |

### 特色需求（核心差异化，优先级贯穿始终）

- **终端内图片显示**：支持 Kitty graphics protocol，pi 等现代终端工具可直接在会话中内联显示图片。
  - pi 通过终端能力探测选择图片协议，因此终端必须正确响应 Kitty graphics 查询（APC `Gi=31;a=q` 等）并渲染 placement。
  - 同时也应支持 Kitty keyboard protocol（pi 的按键处理依赖它）。
  - 调研确认：GUI SSH 客户端中仅 iTerm2 支持终端图片（且为自家私有协议，不兼容 Kitty），**Kitty graphics 在此品类中基本空白，是 dssh 的独家卖点**。
  - 已实现：双击图片弹预览窗（v0.2.0）。

## 非功能需求

- **稳定**：不出现渲染黑屏；长时间挂机会话可靠；断线有明确反馈而非静默卡死（对应 P1-11）
- **好看**：现代简洁 UI，参考 iTerm2
- **一致性优先**：使用 Electron 固定 Chromium 版本，降低设备差异；控制终端和后台资源占用。

## 明确不做（当前阶段）

调研后维持不做，理由见括号：

- 批量多机操作 / 命令群发（运维场景，个人用不到）
- 会话录制（asciinema 等外部工具可替代）
- 多协议支持：Telnet / Serial / RDP / VNC（electerm 的教训：广度拖垮质量）
- X11 转发（现代工作流基本不需要）
- AI 助手 / 命令自动补全（Xterminal/Termius 的卖点，但与"轻量稳定"定位冲突，且 pi 本身已覆盖 AI 场景）
- 配置云同步（单机自用，git 管理配置即可）
- 移动端 / Web 版、团队协作

## 里程碑

1. **M0 验证 demo**：ghostty-web + 本地 pty（→ SSH），跑通 Kitty 图片显示与 pi 兼容（最高风险项优先）✅
2. **M1 MVP**：Tauri 骨架 + 单服务器 SSH 连接 + 终端多标签 ✅
3. **M2**：服务器列表/分组 + 凭据自动登录 + 主题系统 ✅
4. **M3**：SFTP 面板 ✅
5. **M4**：端口转发 + 分屏 + 监控面板 ✅（→ v0.2.0）
6. **M5 体验补齐（P1）**：终端搜索 + 复制粘贴行为 + 多行粘贴警告 + 断线重连
7. **M6 连接增强（P1）**：导入 ssh_config + 登录后自动执行 + ProxyJump + 会话日志
8. **M7 打磨（P2 挑选）**：命令面板 + 双击编辑远程文件 + 进程完成通知 + 状态恢复
