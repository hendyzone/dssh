# 用 VS Code 打开远程目录

1. 本机安装正式版 VS Code 和 Microsoft 的 Remote - SSH 扩展。
2. 在 dssh 的 SFTP 面板进入项目目录，点击「VS Code 远程打开」。
3. 在 VS Code 中完成主机指纹确认、密码或私钥口令提示。

如果终端正在 tmux 中运行 Codex、Claude 或 pi，先点击「tmux 工作目录」选择对应窗格，再点击打开。打开的是 SFTP 当前显示的目录，不是尚未提交的路径输入框内容。

自动复用已保存连接的地址、端口、用户名和私钥路径。密码和私钥口令不会写入文件或命令行，VS Code 建立自己的 SSH 连接，并按其正常流程安装远程服务。

连接配置保存在本机 `~/.ssh/dssh-vscode/*.conf`。首次使用时，在 `~/.ssh/config` 顶部加入 Include；已有配置先备份为同目录的 `config.dssh-backup-时间戳`。原有条目保留。若 VS Code 手动设置了其他 `Remote.SSH: Config File`，需要在该配置中加入相同 Include，或恢复使用默认配置。

Windows 自动查找常见安装位置及 PATH 中的 Code.exe；自定义或便携安装可将 Code.exe 所在目录加入 PATH，然后重启 dssh。

验证：前端命令参数测试、目录 URI 编码和配置字符校验通过。没有使用真实服务器凭据进行 VS Code 连接测试。
