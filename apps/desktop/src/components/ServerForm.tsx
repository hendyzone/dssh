import { useState } from "react";
import type { ServerEntry } from "../types";

interface Props {
  onSubmit: (s: ServerEntry) => void;
  onCancel: () => void;
}

// 新建服务器表单（M1 简化版：分组/标签后续版本再加）
export default function ServerForm({ onSubmit, onCancel }: Props) {
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("root");
  const [authMethod, setAuthMethod] = useState<"password" | "publicKey">(
    "password",
  );
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");

  const valid =
    host.trim() !== "" && username.trim() !== "" && Number(port) > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      id: crypto.randomUUID(),
      name: name.trim() || `${username}@${host}`,
      host: host.trim(),
      port: Number(port),
      username: username.trim(),
      authMethod,
      password: authMethod === "password" ? password : undefined,
      keyPath: authMethod === "publicKey" ? keyPath.trim() : undefined,
      passphrase:
        authMethod === "publicKey" && passphrase ? passphrase : undefined,
    });
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>新建服务器</h3>
        <label>
          名称（可空）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的服务器"
          />
        </label>
        <label>
          地址 *
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.1 或 example.com"
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            端口 *
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              type="number"
              min="1"
              max="65535"
            />
          </label>
          <label>
            用户名 *
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
        </div>
        <label>
          认证方式
          <select
            value={authMethod}
            onChange={(e) =>
              setAuthMethod(e.target.value as "password" | "publicKey")
            }
          >
            <option value="password">密码</option>
            <option value="publicKey">私钥</option>
          </select>
        </label>
        {authMethod === "password" ? (
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        ) : (
          <>
            <label>
              私钥路径
              <input
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
              />
            </label>
            <label>
              私钥密码（如有）
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </>
        )}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="submit" disabled={!valid}>
            保存并连接
          </button>
        </div>
      </form>
    </div>
  );
}
