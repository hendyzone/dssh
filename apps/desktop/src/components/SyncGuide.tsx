import { Button } from "./ui/button";
import { useState } from "react";

function SetupLink({ label, url }: { label: string; url: string }) {
  const [message, setMessage] = useState("");
  return (
    <div className="sync-setup-link">
      <code>{url}</code>
      <Button
        variant="outline"
        size="sm"
        className="btn-secondary"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setMessage("已复制，请在浏览器打开");
          } catch {
            setMessage("请选中网址，手动复制到浏览器");
          }
        }}
      >
        复制{label}链接
      </Button>
      <small role="status">{message}</small>
    </div>
  );
}

export default function SyncGuide() {
  return (
    <div className="sync-guide">
      <p>
        把连接列表加密备份到你自己的 GitHub 仓库，再在另一台电脑恢复。这里是
        <strong>手动备份与恢复</strong>，不会自动同步或合并。
      </p>
      <div className="sync-journey">
        <span>原电脑：填好配置 → 上传备份</span>
        <span>另一台电脑：相同仓库和同步密码 → 下载恢复</span>
      </div>
      <details open>
        <summary>第一次使用？按这 3 步准备</summary>
        <ol className="sync-steps">
          <li>
            <strong>准备一个 GitHub 仓库</strong>
            <p>
              登录 GitHub 后新建仓库，名称可用 dssh-config，建议选择
              Private（私有）并勾选 Add README。已有仓库也可以使用。
            </p>
            <SetupLink label="创建仓库" url="https://github.com/new" />
          </li>
          <li>
            <strong>生成访问令牌（PAT）</strong>
            <p>这是给 dssh 的通行证，不是 GitHub 登录密码。</p>
            <SetupLink
              label="创建令牌"
              url="https://github.com/settings/personal-access-tokens/new"
            />
            <p>
              选择 Fine-grained token → Resource owner 选仓库所有者 → Repository
              access 选 Only select repositories，并勾选该仓库 → Repository
              permissions 中设置 <strong>Contents: Read and write</strong>
              。Metadata 保留默认只读权限。
            </p>
            <p>
              设置有效期，生成后立即复制令牌，粘贴到下方。组织仓库可能需要管理员批准。
            </p>
          </li>
          <li>
            <strong>自己设置一个同步密码</strong>
            <p>
              它用来加密备份，与 GitHub、SSH 密码无关。另一台电脑下载时必须使用
              <strong>同一个同步密码</strong>；忘记后无法解密旧备份。
            </p>
          </li>
        </ol>
      </details>
      <div className="sync-scope">
        <strong>会同步什么？</strong>
        <p>
          连接名称、地址、分组、认证方式、SSH
          密码、私钥文件及口令、端口转发规则、主题和字体、面板左右位置、左栏宽度、空文件夹、排序和折叠状态都会由同步密码加密后上传。
          恢复时密码写入本机系统凭据库，私钥保存到应用私钥目录并自动更新连接路径。
        </p>
        <p>
          另一台电脑仍需填写 GitHub 访问令牌和同步密码以读取备份。当前运行的
          SSH/tmux
          进程不会随配置迁移。旧版备份不含凭据和界面配置，需要先在原电脑用新版重新上传。
        </p>
      </div>
    </div>
  );
}
