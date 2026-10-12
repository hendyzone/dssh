# OSC 7501 程序状态

dssh 接收 [Program Status Protocol v0.4（2026-10-10）](https://www.superlogical.com/rex/docs/build/program-status)。支持该协议的程序可直接向终端输出状态，无需安装 dssh Hooks。状态显示在现有「任务状态」面板，包含程序名、记录标题、子记录 ID、等待原因和百分比；卡片标明来源终端。

## 状态、未读与兼容

| 上报 | 面板行为 |
| --- | --- |
| `idle` | 等待下一条指令 |
| `working` | 处理中，可显示 `progress=0..100` |
| `blocked` | 需要关注；`permission`、`question`、`auth` 分别显示等待批准、回答、登录 |
| `done` | 结果待查看；查看后可保留为已查看，不表示整个 Agent 任务完成 |
| `error` | 程序报告失败并停止 |
| `clear` | 删除目标记录及子记录；没有 ID 时删除本终端全部记录 |

后台终端进入需要关注、完成或错误状态时，使用现有未读提醒；重复上报不重复提醒，桌面提醒受频率限制且需先开启。点击任务或应用内提醒返回来源终端；「全部已读」只确认提醒，不等于程序上报 `clear`。

Claude、Codex、pi 的 Hooks 接入与移除方式保持不变。同一普通终端中已经有对应程序的原生状态时，延迟到达的 Hook 不覆盖它；未实现协议的程序仍可使用 Hooks。文字推测仍标为「推测」，不会从协议的 `msg` 或 `title` 推断状态。带 `pane_ps_*` 扩展的 tmux 可直接采集内部窗格状态并精确跳转，原版 tmux 继续兼容 Hooks 和透传，见下文。

## 程序接入

最简单的 POSIX shell 示例：

```sh
printf '\033]7501;state=working:app=cargo:progress=40\033\\'
printf '\033]7501;state=blocked:app=cargo:kind=question:msg=Q29udGludWU/\033\\'
printf '\033]7501;state=done:app=cargo\033\\'
```

`msg` 示例解码为 `Continue?`。文本用 UTF-8 的标准 base64，每条报告重复需要保留的字段；同一 ID 的更新是整体替换。`id=build/test` 可与根记录并存；没有 `app` 的记录继承最近祖先的程序名。发送 `state=clear:id=build` 会同时删除 `build/test`。

支持 ST 和 BEL 结束符，且序列可跨输出分片。可选探测请求 `ESC ] 7501 ; ? ST` 得到固定回复：

```text
ESC ] 7501 ; ?:states=idle,working,done,blocked,error:kinds=permission,question,auth ST
```

回复不包含程序提供的文本。普通 SSH 和本地终端均通过对应 PTY 写回，探测本身不创建任务或未读提醒。对于由 dssh 管理的 tmux 附加标签，dssh 不向外层 PTY 写回探测回复；补丁版 tmux 自己向发起请求的 pane 回复，原版的透传只提供单向上报兼容。

每个 dssh 终端独立保存记录。主屏／备用屏切换不改变状态，RIS 清空、DECSTR 保留；收到 OSC 133 A 或终端所连进程退出时清除 `working`、`blocked`，保留 `done`、`error`。因此，运行在 shell 内的短命令应在结束前主动上报 `done`／`error`，用户取消则上报 `idle`。关闭终端时移除其任务，重连从新的记录集开始。

普通 SSH 会话的 bash/zsh 使用现有会话内 prompt 钩子发送 OSC 133 A，异常结束后回到提示符也能清理忙碌状态。该钩子不写远端配置文件。原生本地终端没有自动注入 prompt 钩子；如果本地 shell 未自行发送 OSC 133 A，dssh 无法从屏幕判断某个子程序已经退出，程序需主动上报终态，或由 shell 自行接入提示符标记。SSH 输出会在退出事件前排空，避免早到的退出码吞掉末尾 `done`／`error` 报告。

解析器忽略未知键和畸形 pair，重复键取最后值；未知状态和非法 ID 不落到根记录。坏 base64、无效 UTF-8、文本控制字符或超限数据会使整条报告作废。界面按纯文本显示并处理不可见方向控制符。硬限制包括：序列 4096 字节、键名 16 字节、消息编码／解码后 2732／2048 字节、标题 256／192 字节、程序名 32 字节、ID 共 128 字节且最多 8 层、每层 32 字节；每个终端最多 256 条记录，新增超限时淘汰最久未更新的记录。无需心跳。

## tmux 的边界

### `pane_ps_*` 补丁版

dssh 对每台已连接机器每 2.5 秒采集一次默认 tmux server 的所有 pane，包括非活动窗口。检测 `pane-status-changed` Hook 能力，不依赖版本号；未安装 tmux、未启动 server、原版 tmux 均正常返回不支持，继续使用现有 Hooks／透传。Windows 原生本地终端不运行 POSIX 采集命令；Linux/macOS 本地终端和 SSH 使用同一采集器。

采集 `pane_ps_state/kind/progress/app/title/msg`，以服务器连接配置 ID、`session_id`、`session_created` 和 `pane_id` 标识任务。面板标明会话与 `%pane`，点卡片、应用内提醒或桌面提醒时，先通过现有 `tmux_action` 校验会话创建时间及 pane 归属，再选择其窗口和 pane，并复用已有附加标签／分屏；创建时间改变或 pane 不再属于该会话时显示错误、保留未读。tmux 的创建时间精度为秒，server 在同一秒重启并复用相同会话／窗格 ID 的极端情形无法依靠现有身份模型区分。

首次采集和断线恢复不重放旧通知。重复快照和仅进度改变不产生新提醒；观察到新的 `blocked/done/error` 转换时记录未读，桌面通知每个 pane 最多每 5 秒一次。只有当前实际活动 pane 的新快照或成功点击跳转会确认该 pane，其他隐藏 pane 保持未读。采集失败时显示状态未知并保留上次结果，恢复后重新核对；`clear`、窗格消失或会话重建会移除相应旧记录。

同一准确 pane、相同明确 `app` 的原生 `working/blocked` 优先于 Hooks。`idle/done/error` 会跨 shell 提示符留存，而补丁没有提供提示符事件或版本号，因此它们保留供查看，但不阻止后续 Hooks 生命周期。无 `app`、不同程序、其他 pane 和原版 tmux 的 Hooks 不受影响；采集失败时新的 Hooks 事件仍可提供状态。

此补丁只保存每 pane 的根记录，忽略所有显式 `id`，不能提供完整 v0.4 的层级记录。dssh 不补造丢失的记录，也不通过 `msg` 推断机器状态。补丁还存在重复无效键覆盖、空白处理和报告限长的规范差异；完整协议解析只适用于直接到达 dssh 的报告。补丁没有事件序号，两个采集之间发生且结束的短暂状态转换无法保证被观察到；重复的相同 `done` 也不能凭空判作新结果。

采集命令只读，不启用透传、不安装 Hook、不修改 `.tmux.conf`、不启动或重启 tmux。输出使用 UTF-8 字节长度分帧，程序文本不进入 shell 命令，也不做递归 tmux 格式展开；快照上限 512 pane、1 MiB，验证失败整份拒绝。该扩展仍以附加进程所在账户的默认 tmux socket 为范围，任意自定义 socket 不会自动发现。

### 原版 tmux 与单向透传

当前 dssh 通过普通 tmux PTY 客户端附加会话。内部每个 pane 是独立 PTY，但外层只收到 tmux 合成的一个输出流。tmux 3.4 不原生转发 OSC 7501；可用 DCS passthrough 传出状态，但它不携带来源 pane 身份。dssh 因此将这些状态标为 **tmux 客户端透传**，点击返回附加标签，不能依据输出猜测内部 pane 或自动切换到它。原生状态与有准确 tmux 身份的 Hook 状态可以同时存在。这里是单向上报兼容，不代表 tmux 内部每个 pane 都完整支持协议。

在目标 tmux pane 中启用透传（只修改该 pane 的运行时配置）：

```sh
tmux set-option -p -t "$TMUX_PANE" allow-passthrough on
printf '\033Ptmux;\033\033]7501;state=working:app=build\033\033\\\033\\'
printf '\033Ptmux;\033\033]7501;state=done:app=build\033\033\\\033\\'
```

也可使用 dssh tmux 面板已有的「图片透传」操作启用同一个 `allow-passthrough` 选项。dssh 不自动修改 `.tmux.conf`。启用选项后，程序仍需进行 DCS 封装：内容中的每个 ESC 加倍，再放在 `ESC P tmux; ... ESC \\` 内。

在 WSL Ubuntu / tmux 3.4 的独立服务中实际验证了以下行为：

- 普通 OSC 7501 被吞掉；DCS 封装且 `allow-passthrough=on` 时能到达外层。两个可见 pane 发出同一报告，外层收到相同的协议内容，无法区分来源。多个程序使用根记录会互相替换；不同 ID 只能避免命名冲突，不能补上来源身份。
- `on` 仅转发可见 pane；隐藏窗口的报告丢失。`all` 能转发隐藏窗口，但仍没有身份和生命周期信息，不能据此宣称完整的多 pane 支持。
- 封装后的特性探测可以到达外层；在测试中模拟外层回复时，回复进入当时的**活动 pane**。非活动 pane 发起探测时收不到回复，活动 pane 收到不属于它的回复。因此 dssh 对已知 tmux 附加终端不发送协议探测回复。tmux 自己回答 `CSI c`，该回复也可先于外层协议回复。程序可以不探测而直接上报。手工在普通 shell 中附加的 tmux 没有 dssh 管理身份，无法应用这项识别保护。
- 普通 OSC 133 A 不传出；封装后虽能传出，却没有源 pane。一个内部 pane 退出而另一 pane 仍在时，外层 PTY 不退出，也没有自动状态清理报告。因此外层无法替每个内部 pane 准确执行退出／提示符清理。程序应主动发送终态或 `clear`；封装提示符会影响外层整个记录集。

原版 tmux 需要所有窗口的状态、精确 pane 跳转和生命周期时，继续使用 [Hooks 接入](ai-status.md)。支持上述扩展的补丁版则通过独立的只读命令采集，不受外层透传来源缺失的限制。

## 可复跑验证

Python 3 标准库脚本会创建临时目录、专属 `-S` socket、禁用用户配置并使用真实原始 PTY；结束时仅销毁自己创建的服务。不会连接或操作用户已有 tmux 会话。

```sh
python3 apps/desktop/tests/osc7501_tmux_test.py
```

在仓库目录的 Windows PowerShell 中：

```powershell
wsl -e python3 /mnt/d/workspace/dssh/apps/desktop/tests/osc7501_tmux_test.py
```

4 个测试覆盖转发／来源缺失、探测回复路由、DA 回复顺序、内部提示符／退出。它们记录 tmux 3.4 的真实行为；升级 tmux 后若断言变化，应重新检查这些兼容边界。dssh 解析器、记录生命周期、未读与 Hooks 兼容另由前端测试覆盖。

仓库保留实际捕获的 `tests/fixtures/osc7501-tmux-3.4.json`，供前端重新播放工作／完成报告及 tmux 绘屏控制字节。需要更新样本时：

```sh
python3 apps/desktop/tests/osc7501_tmux_test.py --record-fixture apps/desktop/tests/fixtures/osc7501-tmux-3.4.json
```

参考：[OSC 7501 规范](https://www.superlogical.com/rex/docs/build/program-status)、[tmux 手册](https://man.openbsd.org/tmux.1)。

### 附件补丁的隔离验证（2026-10-11）

实际验证使用附件 `tmux-osc7501-patch-ee789c7.zip` 中的补丁，应用到官方 tmux 3.7c 源码，在 WSL Ubuntu 24.04 的唯一临时目录内编译。编译依赖只下载并解包到该目录，未全局安装；可执行文件使用私有 prefix，没有替换系统 tmux，也没有部署到远端。补丁 SHA-256 为 `5bcfa516e9e43469210dcd93b3d46e899965f1856b1eb069639b1210ba1073ec`。

```sh
TMUX_BIN=/absolute/path/to/patched/tmux \
REFERENCE_TMUX=/usr/bin/tmux \
python3 apps/desktop/tests/osc7501_pane_ps_test.py
```

8 项测试全部通过。脚本直接读取 Rust `PRODUCTION_COMMAND` 执行采集，导航校验也从 `tmux.rs` 提取生产命令；仅通过临时 PATH 包装器绑定独立 `-S` socket，不使用默认服务。覆盖：

- 隐藏窗口的 pane 状态、中文 UTF-8 字节长度及标题／消息原样往返；分隔符、引号、反引号、`$()`、`#()` 和 tmux 格式文本没有被执行或递归展开。tmux 3.7c 自身拒绝含换行／制表符的会话名，此边界亦有断言；采集器对含换行字段的分帧另有 Rust 合成测试。
- 原生探测回复回到发起请求的隐藏 pane，且先于 DA；提示符、`clear` 和退出只作用于源 pane，退出清理 `working` 并保留 `done`。显式子记录 `id` 被补丁忽略，确认了根记录限制。
- 隐藏窗口定位、会话归属与创建时间校验；另一 pane 已放大时，生产跳转会退出放大并显示目标。复用会话 ID 且创建时间变化时拒绝旧身份。
- 未启动 server 时返回不支持且不创建 server；原版 tmux 3.4 正常降级。原版透传测试 4 项另行复跑通过。

会话身份沿用现有 `session_id`／`session_created` 契约，后者只有秒级精度。复用测试间隔 1.05 秒后重启专属 server，验证创建时间改变时旧身份被拒绝；若 server 在同一秒内重启并恰好复用相同会话和 pane ID，现有字段无法区分，此项不在精确拒绝保证内。

附件自带 `test-ps.sh` 已先审阅，再以唯一 `PS_SOCK` 和私有 `TMUX_BIN` 运行，43 项功能断言全部通过；没有运行其部署脚本。以上测试验证补丁实际行为，不代表补丁完整符合 v0.4。

真实采集样本保存在 `apps/desktop/tests/fixtures/tmux-pane-ps-3.7c.json`，由 Rust 生产解析器回放并逐字段断言。需要更新样本时，在上述命令额外设置 `PANE_PS_FIXTURE=apps/desktop/tests/fixtures/tmux-pane-ps-3.7c.json`。Windows 可用 `powershell -File apps/desktop/tests/run_tmux_program_status_tests.ps1` 运行隔离 Rust 解析器测试。
