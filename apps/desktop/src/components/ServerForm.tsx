import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ServerEntry } from "../types";

interface Props {
  /** 编辑模式：传入已有条目；不传为新建 */
  initial?: ServerEntry;
  /** record 已含 id；password/passphrase 仅在用户输入了新值时非空（空=保持不变） */
  onSubmit: (
    record: ServerEntry,
    password?: string,
    passphrase?: string,
  ) => void;
  onCancel: () => void;
}

/** 新建/编辑服务器表单。密钥进系统 keyring，表单不回显 */
export default function ServerForm({ initial, onSubmit, onCancel }: Props) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [group, setGroup] = useState(initial?.group ?? "");
  const [authMethod, setAuthMethod] = useState<"password" | "publicKey">(
    initial?.authMethod ?? "password",
  );
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [sshKeys, setSshKeys] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState("");

  useEffect(() => {
    if (authMethod !== "publicKey") {
      setSshKeys([]);
      return;
    }

    let cancelled = false;
    invoke<string[]>("list_ssh_keys")
      .then((keys) => {
        if (!cancelled) setSshKeys(keys);
      })
      .catch(() => {
        if (!cancelled) setSshKeys([]);
      });
    return () => {
      cancelled = true;
    };
  }, [authMethod]);

  const chooseKeyFile = async () => {
    const selected = await open({
      title: "选择私钥文件",
      defaultPath: "~",
      directory: false,
      multiple: false,
    });
    if (typeof selected === "string") setKeyPath(selected);
  };

  const valid =
    host.trim() !== "" && username.trim() !== "" && Number(port) > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit(
      {
        id: initial?.id ?? crypto.randomUUID(),
        name: name.trim() || `${username}@${host}`,
        host: host.trim(),
        port: Number(port),
        username: username.trim(),
        group: group.trim() || undefined,
        authMethod,
        keyPath: authMethod === "publicKey" ? keyPath.trim() : undefined,
        hasPassword: initial?.hasPassword,
        hasPassphrase: initial?.hasPassphrase,
      },
      // 用户留空 → undefined（后端保持 keyring 原值）；输入了 → 新值
      password || undefined,
      passphrase || undefined,
    );
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h3>{editing ? "编辑服务器" : "新建服务器"}</h3>
        <label>
          名称（可空）
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="我的服务器"
          />
        </label>
        <label>
          分组（可空）
          <input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="生产环境 / 测试 / 个人…"
          />
        </label>
        <label>
          地址 *
          <input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="192.168.1.1 或 example.com"
            autoFocus={!editing}
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
              placeholder={
                initial?.hasPassword ? "已存钥匙串（留空保持不变）" : undefined
              }
            />
          </label>
        ) : (
          <>
            <label>
              私钥路径
              <div className="key-path-picker">
                <input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={chooseKeyFile}
                >
                  浏览…
                </button>
              </div>
              {sshKeys.length > 0 && (
                <div className="key-chips" aria-label="常用私钥">
                  {sshKeys.map((key) => (
                    <button
                      type="button"
                      className="key-chip"
                      key={key}
                      onClick={() => setKeyPath(`~/.ssh/${key}`)}
                    >
                      {key}
                    </button>
                  ))}
                </div>
              )}
            </label>
            <label>
              私钥密码（如有）
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={
                  initial?.hasPassphrase
                    ? "已存钥匙串（留空保持不变）"
                    : undefined
                }
              />
            </label>
          </>
        )}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn-primary" disabled={!valid}>
            {editing ? "保存" : "保存并连接"}
          </button>
        </div>
      </form>
    </div>
  );
}
