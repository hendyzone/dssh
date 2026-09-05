# UI 组件统一

从 shadcn/ui 官方 `new-york-v4` registry 引入组件源码，放在 `apps/desktop/src/components/ui`，保留 MIT 许可证。使用 Tailwind CSS 4、Radix UI、CVA 和 Lucide 图标；`components.json` 可供以后添加组件。

## 已迁移

- 按钮、文本输入、多行文本、原生下拉框：连接编辑、批量导入、SFTP、tmux、端口转发、任务、代码修改、监控等界面共用组件。
- Dialog：设置、连接编辑、批量导入、连接分组、新建标签、远程文本编辑；保留保存中锁定、未保存内容确认和中文输入法行为。
- Dropdown Menu：连接、文件、终端与标签菜单，统一键盘导航、边缘避让和关闭行为。
- Tabs：设置分类；Tooltip：左右工具栏；Badge：任务状态；Alert：SFTP 成功和失败提示。

## 设计与兼容

- 使用现有主题变量映射 shadcn 语义颜色，支持所有已有明暗主题。
- 桌面密度：普通按钮 28px、输入框 32px、图标按钮 28px；强调色用于主操作、选中态和焦点。危险操作使用柔和红色。
- 旧样式置于 `legacy` CSS 层，组件的视觉样式由共享组件控制。未启用全局 Tailwind Preflight，避免改变终端与 Markdown 的排版。
- 文件树、连接树、终端画布、监控图表和主题预览保留专用布局。复选框、颜色单选和字号滑块继续保留原生表单语义，统一强调色。
- 组件源码按项目 React 18 版本补充 ref 转发。更新 registry 时需保留这些适配。

官方来源：https://ui.shadcn.com/docs/components

验证使用模拟连接数据，没有连接真实 SSH 服务器或操作用户凭据。
