# 批量导入 SSH 连接

点击左侧顶部的「批量导入」按钮（向下箭头），粘贴连接文本，点击「预览导入」。

每行一个连接，例如：

```text
host=example.com port=22 user=root authType=password password=example-only title="测试  服务器"
host=key.example.com user=ubuntu authType=privateKey title=私钥连接
host=identity.example.com user=ubuntu authType=identity identityId=external-example title=身份连接
```

- 支持中文标题、单双引号包围的值、密码内的等号、Windows 私钥路径；空行和以 `#` 开头的注释行会忽略。引号内转义同类引号可用反斜杠。
- `host`、`user`、`authType` 必填；`port` 默认为 22，`title` 默认为地址。可选 `group` 指定分组，`keyPath` 指定本机私钥路径。
- `password` 认证需提供密码；密码通过现有系统凭据库保存，不写入连接列表文件。
- `privateKey` 缺少路径时，在预览中选择默认私钥。`identity` 的 `identityId` 来自外部软件，需映射到本机私钥；相同身份共用映射。加密私钥的口令可在导入后编辑连接补充。
- 未补齐认证信息或校验失败的行不会导入；可以先导入已就绪的行，再补齐其余行。预览不显示密码。
- 地址、端口、用户名相同的连接视为重复，跳过并保留已有连接。同一地址端口下的不同用户名可分别导入。
- 保存按行进行；若部分失败，成功项保留，点击导入只会重试未成功项。导入不自动连接服务器。

粘贴内容仅在当前导入窗口中处理，不保存为导入历史。关闭窗口后，如需继续未完成项，请重新粘贴。
