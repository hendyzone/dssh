<p align="center">
  <img src="assets/logo-256.png" alt="dssh 标志" width="88" />
</p>

<h1 align="center">dssh</h1>

<p align="center">把远程终端、文件和开发任务放在同一个工作区。</p>
<p align="center"><strong>v1.2.27</strong> · Tauri SSH 客户端 · Windows / macOS / Linux</p>
<p align="center"><a href="README.md">English</a> | <strong>简体中文</strong></p>

dssh 面向日常远程开发与服务器管理：连接服务器、在 tmux 中运行长任务、编辑远程文件、查看代码差异，也能给远程 Codex、Claude 等工具粘贴截图路径；带 Agent 团队的项目还能在同一个窗口里看成员状态、任务卡片和模型额度。

![dssh 工作区：左侧管理服务器，中间使用终端，右侧浏览远程文件](docs/images/workspace.png)

*当前应用前端的界面截图，使用虚构服务器、示例文件和模拟终端输出；不包含真实连接信息。下方截图同样使用演示数据。*

## ✨ 功能一览

| 想做什么 | dssh 提供什么 |
| --- | --- |
| 管理多台服务器 | 文件夹分组、搜索、最近连接、拖拽排序、克隆与批量导入 |
| 同时处理多个会话 | 多标签页、左右 / 上下双窗格分屏、连接状态与断线重连、本地终端 |
| 让远程任务持续运行 | tmux 会话、窗口和窗格管理，Lead / Worker 会话按项目自动分组，重新连接后继续附加 |
| 处理远程文件 | SFTP 文件树、上传下载（含整个文件夹 / 多选递归下载）、在线文本编辑，HTML / Markdown / 图片在标签页中预览 |
| 配合终端 AI 工具工作 | 截图上传并插入路径、终端内图片显示、任务状态与提醒（Hooks 或 OSC 7501 程序状态，含 tmux 窗格跟踪） |
| 看住一支 Agent 团队 | 团队面板实时显示每个成员的状态、当前卡片和最近提交，并分出「等 Lead」「已交付·待验收」「空闲·可派活」 |
| 看懂 agent 说的任务编号 | 团队面板锁定项目后输编号直接查看任务卡片；终端里的真实编号悬停看状态、点击看详情（只读 taskboard） |
| 掌握模型额度 | 「模型额度」面板列出每台服务器上各渠道的剩余额度 |
| 查看项目改动 | 按未暂存、已暂存和新文件分组，查看 Git 差异 |
| 访问远程服务 | 本地转发、远程转发、动态 SOCKS5 代理 |
| 了解服务器状态 | CPU、内存、负载、网络、磁盘与进程监控 |
| 在多台电脑间切换 | 通过 GitHub 加密备份和恢复连接、凭据、私钥、任务查询及界面设置 |

## 🖥️ 连接与终端

- **整理连接**：支持多级文件夹、搜索、最近使用、拖动连接排序与移动分组；可以克隆现有配置，也可以预览后批量导入连接文本。
- **密码与私钥登录**：保存的密码和私钥口令交给系统凭据库管理，私钥可通过文件选择器指定。
- **多会话并行**：同一服务器可打开多个标签；支持标签重命名、复制会话和批量关闭。单个标签可左右或上下分成两个窗格。
- **断线后继续操作**：显示连接状态，断线后保留终端滚动内容，按 `R` 或点击按钮原地重连。
- **重启恢复工作现场**：自动恢复标签、分屏、焦点和连接分组；普通 SSH 窗格尝试回到上次目录，由 dssh 打开的 tmux 窗格重新附加原会话。关闭的标签不会再恢复，普通 shell 进程与滚动历史不保存。
- **本地终端**：欢迎页的「打开本地终端」或标签栏 `+` →「本地终端」打开本机 shell（Linux/macOS 用默认登录 shell，Windows 用 PowerShell），支持多标签、分屏和复制粘贴。
- **中文与外观**：支持中文输入，内置 Nord、Tokyo Night、Catppuccin 等深浅色主题；字体、字号和主题即时生效，工具面板可左右停靠并调整宽度。Linux 窗口使用跟随主题的紧凑标题栏。

## 📁 文件就在终端旁边

在同一个窗口里浏览目录、改配置、读文档，或把项目交给本地编辑器。

- **浏览与定位**：文件树、隐藏文件开关、路径输入、目录筛选；可跟随终端目录，也可选择 tmux 窗格的工作目录。
- **传输与管理**：拖拽上传、下载、新建目录、重命名和删除；上传队列显示进度与速度，支持取消。
- **定位下载文件**：下载完成提示自动提供「打开所在目录」，单文件在 Windows 资源管理器 / macOS Finder 中定位，文件夹或多选下载打开保存目录；提示保留至关闭或被后续操作替换。
- **下载整个文件夹**：目录右键「下载文件夹…」或 Ctrl/⌘、Shift 多选后「下载所选」，选择本地目录后递归下载并保留结构；整批作为一个传输项显示文件数、字节、速度和当前文件，可取消（已完成的文件保留），本地同名时一次性选择合并（覆盖 / 跳过）或另存为“名称 (1)”。
- **在线编辑**：编辑不超过 1 MB 的 UTF-8 文本，保存前检查远端冲突并建立备份；Markdown 可切换渲染预览与源码编辑。
- **本地打开**：右键「下载并打开」可下载文件并用本地应用打开；也可通过 VS Code Remote - SSH 打开当前远程目录。
- **网页标签页**：在终端选中远程 HTML 的绝对路径或 `file:///…html`，Shift+右键选择「在 dssh 新标签页打开」。通过当前 SSH 读取并在隔离页面中显示，可刷新、切换与关闭，不会关闭原终端。支持 1 MB 以内的 UTF-8 单文件 HTML，同目录图片、CSS 等资源暂不加载；网页标签不随重启恢复。选中 HTTP(S) 地址也可内嵌打开，禁止内嵌的网站可改用系统浏览器。
- **Markdown 与图片标签页**：同一菜单也支持 `.md/.markdown/.mdown` 和 PNG、JPEG、GIF、WebP、BMP、SVG、ICO、AVIF。Markdown 支持表格、代码块以及远程相对路径图片；图片可适应窗口或显示原始尺寸。文档限 1 MB UTF-8，单张图片限 20 MB，具体图片格式取决于系统 WebView 解码支持。
- **从 SFTP 预览**：双击 HTML、Markdown 或图片，或右键选择「在 dssh 新标签页打开」。需要本地应用时仍可选择「下载并打开」；其他文件保持原有双击下载打开行为。

支持拖入文件夹递归上传，保留子目录和空目录；下载到本地应用后所做的修改不会自动回传。详见[文件工作区](docs/file-workspace.md)与 [VS Code 远程打开](docs/vscode-remote.md)。

## 🔁 用 tmux 留住工作现场

![tmux 管理面板：查看会话、窗口、运行中的程序及工作目录](docs/images/tmux.png)

- 自动发现远端会话，新建、重命名，或在新标签中附加已有会话。
- 管理窗口和窗格，切换焦点、左右 / 上下分屏、放大还原、进入复制模式。
- **按项目分组**：手动分组（保存在远端会话的 `@dssh_group` 选项）优先；其余会话按名称自动归类——`<项目>-lead` 或 `lead-<项目>` 归入 **Leads** 组（默认展开，显示项目名），`worker-<项目>-<机器>-<工具>` 这类 worker 会话归入 **Workers** 组并按项目分子组（默认折叠，带数量）。卡片显示去掉前缀的短名，悬停可见全名；顺序为手动分组 → Leads → Workers → 未分组。
- 关闭附加标签只分离本客户端，远端任务继续运行；网络断开后最多自动尝试重连三次。
- 可为所选会话启用鼠标，为指定窗格启用图片透传。

远端需安装 tmux，目前管理默认 socket。图片透传需要 tmux 3.3+ 及远端应用配合。详见 [tmux 使用说明](docs/tmux.md)。

## 🖼️ 更方便地使用终端 AI 工具

**截图 → 粘贴到终端 → 上传到远程 → 插入图片路径 → 补充问题并发送。**

复制截图后，在目标终端粘贴，dssh 会上传 PNG 并插入远程绝对路径，不会自动回车。支持 20 MB 以内的 PNG；是否能读取图片由远端工具和模型决定。

支持 Kitty graphics 协议的程序还可以在终端内直接显示图片，双击即可打开预览窗。

配合右侧工具面板，可以同时关注任务进度和代码变化：

- **任务状态与提醒**：查看终端活动、断开状态和工具通知，点击任务卡片跳回对应窗格；可开启桌面提醒。根据终端文字推测的完成、错误或等待状态会明确标注。
- **统一 AI 状态**：在任务面板按服务器接入 Claude、Codex、pi 的事件，统一显示处理中、等待确认、本轮结束和退出。支持移除接入，并保留已有 Hooks。[接入说明](docs/ai-status.md)
- **OSC 7501 程序状态**：实现 [Program Status Protocol](docs/program-status.md) 的程序直接向终端输出状态（空闲、处理中、需要关注、完成、错误，可带进度），无需安装 Hooks。打了 `pane_ps_*` 补丁的 tmux 会被只读采集所有窗格（含隐藏窗口），点卡片或提醒精确跳到对应窗口和窗格；原版 tmux 可经 DCS 透传单向上报，来源只标为附加标签。
- **代码修改**：选择远程 Git 项目，查看未暂存、已暂存及新文件，点击查看差异。此面板只读，包含该工作区的所有改动。

详见[工作区工具](docs/workspace-tools.md)与[程序状态协议与 tmux 实测](docs/program-status.md)。

## 👥 Agent 团队、任务与额度

可选的 **Agent 协作** 可在「设置 → Agent 协作」按 tmux 会话 + worktree 配置并开启，查看 taskboard 的共享任务与交接，
通过 amail 查询、预览发送或回复消息。默认关闭，凭据留在远端。详见 [Agent 协作接入](docs/agent-collaboration.md)。

**团队面板**：在「设置 → Agent 协作」配置团队服务地址和订阅项目，通过 WebSocket 实时读取成员与状态，不依赖当前终端绑定 tmux 会话；仍可跨服务器一键打开已登记成员的 tmux 会话（[从 Lead 跳转到成员终端](docs/agent-collaboration.md#从-lead-跳转到成员终端)）。
「动态」和「成员」两页使用服务状态；只有服务明确标记 `no_agent` 的成员才回退到已配置 taskboard 的只读会话采集（`GET /api/v1/agent-sessions`），看板同时提供当前卡片与最近提交等信息。

**v1.2.27:** 应用内更新：启动时（及「设置 → 检查更新」）从 GitHub Releases 发现新版本，显示版本与更新说明，确认后下载、校验签名并重启；deb/rpm 安装只给下载链接。像素办公室把临时 worker 放进单独的临时工位并标出所属卡，卡完成后标「待回收」。

**v1.2.26:** 远程图片、Markdown、HTML 预览页的工具栏新增「下载」按钮，直接把文件存到本机，进度、成功提示和「打开所在目录」与 SFTP 面板一致。

**v1.2.25:** Member cards in the team panel keep the name right next to the status dot; the AI summary now sits on its own row instead of widening the first column.

**v1.2.24:** Following the focused terminal now also works for Lead sessions whose name differs from the project name: the session is matched against the team roster instead.

**v1.2.23:** The pixel office fits a whole team (Lead plus up to eight workers) on one screen with adaptive sizing, puts stuck and waiting members first, dims idle desks and hides secondary details. It follows the project of the focused terminal and can go full screen with the header hidden. Each member shows the task card it is working on, preferring the roster entry over the branch binding. AI summary lines no longer show the summarizer model, models fall back to the roster role, and team panels keep separate projects and locks per tab.

**v1.2.22:** Team service AI summaries are shown read-only with an on-demand refresh. Team service settings (URL, subscriptions and token) travel in the encrypted GitHub sync, and subscriptions are checked against the projects the service exposes. Task lookup locks follow the open team. A redesigned pixel office shows every member's desk with live state, task note and AI summary. Member names are consistent across panels. Settings are merged into one Team page, task lookup only uses a directly reachable board, and the task list and detail card are easier to read and close.

**v1.2.21:** The configurable team service supplies live rosters and status over WebSocket, with member editing and conflict handling. Reading and writing the Lead's local roster over SSH has been removed. Local AI summary generation is disabled; generation will move to the server.

- 成员按状态分组：**需要处理**（卡住、确认框、输入框残留、会话已离开但卡仍在进行中）排最前并高亮；**等 Lead**（worker 已空闲但卡仍在进行中 / 阻塞，按等待时长排序）；**已交付·待验收**（卡在待验收）；运行中；**空闲·可派活**（名下没有进行中 / 阻塞 / 待验收的卡）。Lead 自己的会话单列。
- 面板顶部汇总：需要处理 N · 等 Lead N（最长 X）· 待验收 N · 可派活 N。
- Lead 手写的「当前在做」显示为「Lead 备注」并标注更新时间，超过 24 小时标「可能过期」。离线时继续显示服务连接状态与缓存数据。
- 已有缓存 AI 摘要保留为只读。

**任务编号查询**：agent 只说「T1090」「AM-42」时，在「团队」面板顶部输入编号即可看到标题、状态列、负责人、摘要、验收结论、阻塞原因和前置依赖；
锁定项目后只需输编号（`1090` 自动补成 `T1090`），未锁定可输「项目 编号」或只输编号跨项目精确查找。
终端里出现的、确实存在于该项目看板上的编号会被识别：悬停显示简要卡片，点击打开完整卡片；「在看板中打开」直接打开网页看板上这张卡的详情。在「设置 → 任务查询」填写看板地址。
详见 [任务编号查询](docs/agent-collaboration.md#任务编号查询)。

**模型额度面板**：右侧工具栏的「模型额度」把 dssh 内置的 [`model-quota`](tools/model-quota/) 脚本经 SSH 标准输入送到每台已连接的服务器，用 `python3 - --json` 运行（固定命令，只读，最长 75 秒，丢弃 stderr）。脚本读取 Claude Code、Codex、Cursor、pi、Antigravity 在那台服务器上已有的登录凭据，额度按账号在哪台机就在哪台机查。各渠道统一换算成**剩余百分比**：≤ 25% 黄、≤ 10% 红，失败显示脱敏后的原因；账号做掩码，同一账号出现在多台服务器时标「与 X 共用」。多台服务器可切换或并列查看；支持手动刷新，面板打开且窗口可见时每 5 分钟自动刷新。
服务器只需要 `python3`（3.8+），不往服务器装任何东西。非交互 SSH 用的代理、new-api 中转站地址等可选配置写在服务器的 `~/.config/model-quota/config`（见[脚本说明](tools/model-quota/README.md)）。「复制提示词」会生成一段给那台服务器上终端 AI 的话：写明这台机的具体问题（缺 python3、未设代理、登录过期、中转站未配置等）和修法，最后让它跑一遍脚本自检并回报；提示词里不含凭据和账号。本地终端不支持。

给 Claude Code、Codex CLI、pi 的创建 worktree、开箱、认领及交接流程见 [Agent 操作手册](docs/agent-playbook.md)。
程序内「设置 → Agent 协作」支持离线查看、一键复制给 Agent，以及保存完整 Markdown 手册。

## 🌐 转发、监控与同步

| 功能 | 使用方式 |
| --- | --- |
| **端口转发** | 创建本地 / 远程转发或动态 SOCKS5 代理；规则随服务器保存，支持编辑、启停及连接后自动启动。 |
| **服务器监控** | 底部摘要查看 CPU、内存、磁盘和网络速率；展开面板查看趋势、负载、网卡、磁盘读写及进程。 |
| **加密同步** | 在「设置 → 同步」填写 GitHub 仓库、访问令牌和同步密码，上传完整备份，在另一台电脑恢复。 |

同步包含连接、分组、保存的密码、引用的私钥及口令、转发规则、任务查询设置（看板地址、锁定项目、项目绑定）、主题和布局，使用 Argon2 派生密钥与 AES-256-GCM 在本机加密后上传。**恢复会替换本机连接列表**；正在运行的 SSH / tmux 进程不属于备份。详见[完整加密同步](docs/full-sync.md)。

## 🚀 开始使用

1. 安装并启动 dssh，点击左侧 `+` 添加服务器，填写地址、用户名及认证信息。
2. 双击服务器建立连接；需要多个工作窗口时，新建标签或使用分屏。
3. 从终端旁的工具栏打开文件、tmux、团队、任务、代码修改、端口转发、监控或模型额度面板。

本地终端不显示 SFTP、SSH 监控、转发和模型额度，暂不支持截图粘贴；关闭窗格会结束 shell，重新打开应用会创建新 shell。

安装包与构建记录可查看仓库的 [Releases](https://github.com/hendyzone/dssh/releases) 和 [Actions](https://github.com/hendyzone/dssh/actions)。构建流程包含 Windows、macOS 和 Linux；具体可下载平台以对应构建产物为准。

<details>
<summary>从源码运行与构建</summary>

主应用位于 `apps/desktop`，采用 Tauri 2、React、ghostty-web 和 russh。

准备 Node.js 22、Rust stable 和对应平台的 Tauri 2 系统构建依赖。Windows 还需 C++ 构建工具、WebView2 与 NASM；Linux 依赖列表见[构建工作流](.github/workflows/build-windows.yml)。

```bash
cd apps/desktop
npm ci
npm run tauri dev
```

构建安装包：

```bash
npm run tauri build
```

安装包输出到 `apps/desktop/src-tauri/target/release/bundle/`。

</details>

<details>
<summary>更多文档与项目结构</summary>

- [批量导入 SSH 连接](docs/ssh-import.md)
- [文件工作区与截图粘贴](docs/file-workspace.md)
- [任务、代码修改与 Markdown](docs/workspace-tools.md)
- [AI 状态 Hooks 接入](docs/ai-status.md)
- [OSC 7501 程序状态与 tmux](docs/program-status.md)
- [tmux 会话管理](docs/tmux.md)
- [Agent 协作：taskboard 与 amail](docs/agent-collaboration.md)
- [Agent 操作手册](docs/agent-playbook.md)
- [VS Code 远程打开](docs/vscode-remote.md)
- [完整加密同步](docs/full-sync.md)
- [架构设计](docs/architecture.md)

| 路径 | 内容 |
| --- | --- |
| `apps/desktop` | 桌面应用 |
| `vendor/ghostty-web` | 支持 Kitty graphics 的终端组件 |
| `docs` | 功能说明与设计文档（中文） |
| `prototypes/kitty-image` | 早期终端图片协议验证原型 |

</details>

## 自动更新与签名密钥（维护者）

桌面端启动后会后台检查 GitHub Releases 上的 `latest.json`（与 tauri-action 生成的 updater 产物一致）；**设置 → 更新** 可手动检查。Windows / macOS / Linux AppImage 在用户确认后会下载、校验 Minisign 签名并安装；**deb / rpm 仅提示新版本与下载链接**，不覆盖包管理器安装。

`apps/desktop/src-tauri/tauri.conf.json` 里 `plugins.updater.pubkey` 为 Minisign 公钥（与 CI secrets 中的私钥成对）。私钥**不要**进仓库；CI 通过 GitHub Actions secrets 注入：

1. 维护者生成 updater 密钥对（Tauri signer / Minisign），将**公钥**写入 `tauri.conf.json` 的 `pubkey` 并合入 main。
2. 在 GitHub 仓库 Settings → Secrets 添加 `TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
3. 推送 `v*` tag 或走 `build-windows.yml` 工作流；产物含 `latest.json` 与签名安装包。**CI 不会自动创建密钥。**

## 许可证

[MIT](LICENSE) © 2026 hendyzone

第三方组件及其许可证见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。
