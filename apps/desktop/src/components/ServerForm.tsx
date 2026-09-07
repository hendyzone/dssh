import { AppDialog } from "./ui/app-dialog";
import { Button } from "./ui/button";
import { NativeSelect } from "./ui/native-select";
import { Input } from "./ui/input";
import { useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import { open } from "../platform/dialog";
import type { ServerEntry } from "../types";
import { isComposingKey } from "../lib/keyboard";
import { useDialogFocus } from "../lib/useDialogFocus";
import { groupParts, groupSuggestions } from "../lib/serverGroups";

interface Props {
  defaultGroup?: string;
  /** 编辑模式：传入已有条目；不传为新建 */
  initial?: ServerEntry;
  /** record 已含 id；password/passphrase 仅在用户输入了新值时非空（空=保持不变） */
  onSubmit: (
    record: ServerEntry,
    password?: string,
    passphrase?: string,
  ) => Promise<void>;
  onCancel: () => void;
}

/** 新建/编辑服务器表单。密钥进系统 keyring，表单不回显 */
export default function ServerForm({
  initial,
  defaultGroup,
  onSubmit,
  onCancel,
}: Props) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(String(initial?.port ?? 22));
  const [username, setUsername] = useState(initial?.username ?? "root");
  const [group, setGroup] = useState(initial?.group ?? defaultGroup ?? "");
  const [existingGroups, setExistingGroups] = useState<string[]>([]);
  const [authMethod, setAuthMethod] = useState<"password" | "publicKey">(
    initial?.authMethod ?? "password",
  );
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState(initial?.keyPath ?? "");
  const [sshKeys, setSshKeys] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState("");
  const [recordId] = useState(() => initial?.id ?? crypto.randomUUID());
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const savingRef = useRef(false);
  const composingRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const errors = {
    host: host.trim() ? "" : "请填写服务器地址",
    port:
      /^\d+$/.test(port.trim()) && Number(port) >= 1 && Number(port) <= 65535
        ? ""
        : "端口须为 1–65535 的整数",
    username: username.trim() ? "" : "请填写用户名",
    keyPath:
      authMethod === "publicKey" && !keyPath.trim()
        ? "请填写或选择私钥路径"
        : "",
  };
  const fieldError = (field: keyof typeof errors) =>
    attempted && errors[field] ? (
      <span id={`server-${field}-error`} className="field-error">
        {errors[field]}
      </span>
    ) : null;
  const fieldProps = (field: keyof typeof errors) => ({
    name: field,
    "aria-invalid": attempted && Boolean(errors[field]),
    "aria-describedby":
      attempted && errors[field] ? `server-${field}-error` : undefined,
  });
  const cancel = () => {
    if (!savingRef.current) onCancel();
  };

  useEffect(() => {
    let cancelled = false;
    invoke<ServerEntry[]>("servers_list")
      .then((servers) => {
        if (cancelled) return;
        const groups = new Set(groupSuggestions(servers));
        if (initial?.group?.trim()) groups.add(initial.group.trim());
        setExistingGroups([...groups].sort((a, b) => a.localeCompare(b)));
      })
      .catch(() => {
        // 分组建议加载失败时仍可自由输入。
      });
    return () => {
      cancelled = true;
    };
  }, [initial?.group]);

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
    try {
      const selected = await open({
        title: "选择私钥文件",
        defaultPath: "~",
        directory: false,
        multiple: false,
      });
      if (typeof selected === "string" && !savingRef.current)
        setKeyPath(selected);
    } catch (error) {
      setSaveError(`选择私钥失败：${String(error)}`);
    }
  };

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (savingRef.current || composingRef.current) return;
    setAttempted(true);
    setSaveError(null);
    const invalidField = (
      Object.keys(errors) as Array<keyof typeof errors>
    ).find((field) => errors[field]);
    if (invalidField) {
      e.currentTarget
        .querySelector<HTMLInputElement>(`[name="${invalidField}"]`)
        ?.focus();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      await onSubmit(
        {
          ...initial,
          id: recordId,
          name: name.trim() || `${username.trim()}@${host.trim()}`,
          host: host.trim(),
          port: Number(port),
          username: username.trim(),
          group: groupParts(group).join("/") || undefined,
          authMethod,
          keyPath: authMethod === "publicKey" ? keyPath.trim() : undefined,
        },
        // 用户留空 → undefined（后端保持 keyring 原值）；输入了 → 新值
        password || undefined,
        passphrase || undefined,
      );
    } catch (error) {
      setSaveError(`保存失败：${String(error)}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <AppDialog title="服务器连接" onClose={cancel} busy={saving}>
      <form
        ref={formRef}
        tabIndex={-1}
        className="modal"
        aria-labelledby="server-form-title"
        aria-busy={saving}
        noValidate
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key !== "Tab") event.stopPropagation();
          if (composingRef.current || isComposingKey(event.nativeEvent)) {
            if (event.key === "Enter") event.preventDefault();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
      >
        <h3 id="server-form-title">{editing ? "编辑服务器" : "新建服务器"}</h3>
        <fieldset className="server-form-fields" disabled={saving}>
          <label>
            名称（可空）
            <Input
              value={name}
              autoFocus={editing}
              onChange={(e) => setName(e.target.value)}
              placeholder="我的服务器"
            />
          </label>
          <label>
            分组（可空）
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="例如：我的（外网）/公司/深信服"
              aria-describedby="server-group-hint"
              list="server-groups"
            />
            <datalist id="server-groups">
              {existingGroups.map((existingGroup) => (
                <option key={existingGroup} value={existingGroup} />
              ))}
            </datalist>
          </label>
          <small id="server-group-hint" style={{ color: "var(--ui-muted)" }}>
            用 / 分隔层级即可创建子分组；修改此路径可移动连接。
          </small>
          <label>
            地址 *
            <Input
              {...fieldProps("host")}
              aria-label="地址 *"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.1 或 example.com"
              autoFocus={!editing}
            />
            {fieldError("host")}
          </label>
          <div className="form-row">
            <label>
              端口 *
              <Input
                {...fieldProps("port")}
                aria-label="端口 *"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                inputMode="numeric"
              />
              {fieldError("port")}
            </label>
            <label>
              用户名 *
              <Input
                {...fieldProps("username")}
                aria-label="用户名 *"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
              {fieldError("username")}
            </label>
          </div>
          <label>
            认证方式
            <NativeSelect
              value={authMethod}
              onChange={(e) =>
                setAuthMethod(e.target.value as "password" | "publicKey")
              }
            >
              <option value="password">密码</option>
              <option value="publicKey">私钥</option>
            </NativeSelect>
          </label>
          {authMethod === "password" ? (
            <label>
              密码
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  initial?.hasPassword
                    ? "已存钥匙串（留空保持不变）"
                    : undefined
                }
              />
            </label>
          ) : (
            <>
              <label>
                私钥路径
                <div className="key-path-picker">
                  <Input
                    {...fieldProps("keyPath")}
                    aria-label="私钥路径"
                    value={keyPath}
                    onChange={(e) => setKeyPath(e.target.value)}
                    placeholder="~/.ssh/id_ed25519"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    className="btn-secondary"
                    onClick={chooseKeyFile}
                  >
                    浏览…
                  </Button>
                </div>
                {fieldError("keyPath")}
                {sshKeys.length > 0 && (
                  <div className="key-chips" aria-label="常用私钥">
                    {sshKeys.map((key) => (
                      <Button
                        variant="outline"
                        size="sm"
                        type="button"
                        className="key-chip"
                        key={key}
                        onClick={() => setKeyPath(`~/.ssh/${key}`)}
                      >
                        {key}
                      </Button>
                    ))}
                  </div>
                )}
              </label>
              <label>
                私钥密码（如有）
                <Input
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
        </fieldset>
        {saveError && (
          <div className="form-error" role="alert">
            {saveError}
          </div>
        )}
        {saving && (
          <div className="form-status" role="status">
            正在保存服务器配置…
          </div>
        )}
        <div className="form-actions">
          <Button
            variant="outline"
            size="sm"
            type="button"
            className="btn-secondary"
            onClick={cancel}
            disabled={saving}
          >
            取消
          </Button>
          <Button
            variant="default"
            size="sm"
            type="submit"
            className="btn-primary"
            disabled={saving}
          >
            {saving ? "保存中…" : editing ? "保存" : "保存并连接"}
          </Button>
        </div>
      </form>
    </AppDialog>
  );
}
