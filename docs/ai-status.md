# 统一 AI 状态与提醒

任务面板将 Claude、Codex、pi 的工具事件统一显示为「等待输入」「处理中」「需要确认或输入」「本轮已结束」「工具报告错误」「工具已退出」。**本轮结束不表示整个任务完成**，无输出不会被视作完成。

## 接入

1. 连接服务器，打开右侧「任务状态」。
2. 展开「接入 AI 状态」，选择 Claude、Codex 或 pi，点击「接入」。每种工具单独接入；仅在点击后修改所选服务器当前用户的配置。
3. 重启对应工具。Codex 若提示 Hooks 待审核，在 `/hooks` 中审阅并信任 dssh 的 Hook；dssh 不绕过信任检查或修改审批策略。需要支持这些 Hooks 的 CLI 版本。
4. 普通 SSH 终端通过当前 shell 的 `DSSH_PANE_ID` 和本次连接身份关联，重连后不会沿用旧进程状态；更新应用前已经打开的终端需重新连接。tmux 通过默认 socket 的会话 ID、创建时间和远端窗格 ID 关联，保留原 tmux 会话即可。
5. 如需系统通知，点击「开启桌面提醒」。当前应用进程内生效；应用内仍有未读提醒和任务卡片。

远端需 Python 3.8+ 与 POSIX 环境（Linux/macOS）。默认使用 `~/.claude/settings.json`、`~/.codex/hooks.json`、`~/.pi/agent/extensions/dssh-status.ts`；若 SSH exec 环境提供 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 或 `PI_CODING_AGENT_DIR`，则使用相应目录。仅在交互 shell 中设置的自定义目录不会自动传播给 SSH exec。

## 事件与提示

| 工具 | 精确事件 |
| --- | --- |
| Claude | 会话开始、提交提示、工具调用、权限请求、特定等待通知、本轮结束、结束失败、会话退出 |
| Codex | 会话开始、提交提示、工具调用、权限请求、本轮结束、中断、会话退出 |
| pi | 会话开始、Agent 开始/结束、错误、会话退出；支持 `ui_prompt_start/end` 的版本还可上报扩展 UI 等待 |

工具事件优先于终端文字推测。pi 或未接入 Hooks 的普通终端仍可使用文字识别，卡片明确标为「推测」。通用 OSC 弹窗不会覆盖已关联的工具生命周期状态，旧版 Claude 状态接入仍兼容。

每台已连接服务器约 2.5 秒读取一次最新状态，单次请求不重叠；首次读取、网络恢复后的旧状态不会重新弹出完成提醒。同一状态的重复事件不重复通知。网络或状态读取失败显示「状态未知」，不会当作完成。很短的中间状态可能在两次读取间被后续状态替代。

点击**应用内未读提醒或任务卡片**可跳到来源终端；tmux 会先核验会话身份及窗格归属，再切换远端窗口/窗格并复用已打开标签。已关闭的普通终端不会被伪装成原会话重建。当前 Tauri 桌面通知后端只保证投递，系统通知点击跳转不作保证。

## 配置与数据

- 接入脚本保存到 `~/.local/share/dssh/ai_status.py`。JSON 配置按事件合并、原子写入，保留用户原有 Hooks；修改前备份为原文件名加 `.dssh-backup-时间戳`。损坏配置或同名非 dssh pi 扩展不会被覆盖。
- 可在相同入口点击「移除接入」，仅移除 dssh 添加的 Hook/扩展，重启工具后生效；不会恢复整份旧配置覆盖用户后续修改。脚本、备份及已有状态记录保留。
- 状态在远端 `~/.local/state/dssh/ai/`，仅含工具名、状态、时间和终端定位信息。不写入提示词、回答正文、工具参数或 transcript 内容。记录用原子替换，按终端只展示最近活动；超过 24 小时未观察到新事件的记录不再展示。
- Hook 不返回批准、拒绝或继续执行的决策；事件处理有时限，异常不改变 AI CLI 的退出决策。不在 dssh 普通终端或默认 tmux 会话内的调用不会产生记录。
- 使用自定义 tmux socket、不同配置目录或禁用 Hooks 的工具，需要单独接入；此版本不会修改用户的这些设置。

接口依据：[Codex Hooks](https://developers.openai.com/codex/hooks)、[Claude Hooks](https://code.claude.com/docs/en/hooks)、[pi 扩展](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)。
