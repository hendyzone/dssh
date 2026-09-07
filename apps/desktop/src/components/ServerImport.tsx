import { AppDialog } from "./ui/app-dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { useRef, useState } from "react";
import { open } from "../platform/dialog";
import { invoke } from "../platform/core";
import type { ServerEntry } from "../types";
import { upsertServer } from "../store";
import {
  endpoint,
  parseServerImport,
  type ImportRow,
} from "../lib/serverImport";
import { useDialogFocus } from "../lib/useDialogFocus";
import { isComposingKey } from "../lib/keyboard";
import "./ServerImport.css";

export default function ServerImport({
  servers,
  onImported,
  onClose,
}: {
  servers: ServerEntry[];
  onImported: (server: ServerEntry) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState("");
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [keyModes, setKeyModes] = useState<Record<string, boolean>>({});
  const [keyContents, setKeyContents] = useState<Record<string, string>>({});
  const [passphrases, setPassphrases] = useState<Record<string, string>>({});
  const storedKeys = useRef<Record<string, { content: string; path: string }>>(
    {},
  );
  const [group, setGroup] = useState("");
  const [saved, setSaved] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => {
    if (!lock.current) onClose();
  };
  const seen = new Set(servers.map(endpoint));
  const preview = rows.map((row) => {
    const record = row.record;
    const mapping = row.identityId ?? "default";
    const pasted = !record?.keyPath && keyModes[mapping];
    const keyPath = record?.keyPath || (pasted ? undefined : keys[mapping]);
    let status = row.error || "可导入";
    if (record) {
      if (saved.has(record.id)) status = "已导入";
      else if (seen.has(endpoint(record))) status = "重复连接，跳过";
      else if (
        record.authMethod === "publicKey" &&
        !(pasted ? keyContents[mapping]?.trim() : keyPath?.trim())
      )
        status = "待选择私钥";
      else if (record.authMethod === "password" && !row.password)
        status = "缺少密码";
      seen.add(endpoint(record));
    }
    return { row, status, keyPath: keyPath?.trim() };
  });
  const ready = preview.filter((p) => p.status === "可导入");
  const mappings = [
    ...new Set(
      rows
        .filter(
          (r) => r.record?.authMethod === "publicKey" && !r.record.keyPath,
        )
        .map((r) => r.identityId ?? "default"),
    ),
  ];
  const save = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    let count = 0;
    try {
      // The backend updates a shared JSON file; serialize writes to prevent lost records.
      for (const item of ready) {
        const record = {
          ...item.row.record!,
          keyPath: item.keyPath,
          group: item.row.record!.group || group.trim() || undefined,
        };
        try {
          const mapping = item.row.identityId ?? "default";
          if (
            record.authMethod === "publicKey" &&
            !item.row.record?.keyPath &&
            keyModes[mapping]
          ) {
            const content = keyContents[mapping];
            let stored = storedKeys.current[mapping];
            if (!stored || stored.content !== content) {
              try {
                const path = await invoke<string>(
                  "servers_import_private_key",
                  {
                    content,
                    passphrase: passphrases[mapping] || null,
                  },
                );
                stored = { content, path };
                storedKeys.current[mapping] = stored;
              } catch {
                setMessage(
                  "私钥未能保存，请检查完整私钥、加密口令及本机写入权限后重试。",
                );
                return;
              }
            }
            record.keyPath = stored.path;
          }
          const result = await upsertServer(
            record,
            item.row.password,
            passphrases[mapping] || undefined,
          );
          setSaved((prev) => new Set(prev).add(record.id));
          setFailed((prev) => {
            const next = new Set(prev);
            next.delete(record.id);
            return next;
          });
          setRows((prev) =>
            prev.map((r) =>
              r.record?.id === record.id ? { ...r, password: undefined } : r,
            ),
          );
          onImported(result);
          count++;
        } catch {
          // Backend diagnostics may contain sensitive values; keep the UI error generic.
          setFailed((prev) => new Set(prev).add(record.id));
        }
      }
      setMessage(
        `本次已导入 ${count} 个连接。未成功的记录可重试；待补充的记录不会导入。`,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <AppDialog title="批量导入 SSH 连接" onClose={close} busy={busy}>
      <div
        className="modal server-import"
        ref={ref}
        aria-labelledby="import-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !isComposingKey(e.nativeEvent)) {
            e.stopPropagation();
            close();
          }
        }}
      >
        <h2 id="import-title">批量导入 SSH 连接</h2>
        <p>
          每行一个连接，支持
          key=value、中文及引号内的空格。密码保存到系统凭据库。
        </p>
        {!rows.length ? (
          <>
            <label htmlFor="import-source">连接文本</label>
            <Textarea
              id="import-source"
              autoFocus
              spellCheck={false}
              autoComplete="off"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder={
                'host=example.com port=22 user=root authType=password password=示例 title="我的服务器"'
              }
            />
            <div className="import-actions">
              <Button variant="outline" size="sm" onClick={close}>
                取消
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!source.trim()}
                onClick={() => {
                  setRows(parseServerImport(source));
                  setSource("");
                }}
              >
                预览导入
              </Button>
            </div>
          </>
        ) : (
          <>
            <label>
              导入到分组（可选）
              <Input
                disabled={busy}
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="保留原分组，未指定时使用此分组"
              />
            </label>
            {mappings.length > 0 && (
              <p>
                可选择私钥文件或直接粘贴完整私钥。粘贴内容将在导入时保存到本机受限目录，口令保存到系统凭据库。
              </p>
            )}
            {mappings.map((id) => (
              <section
                className="import-key"
                key={id}
                aria-label={
                  id === "default" ? "默认私钥配置" : `身份 ${id} 配置`
                }
              >
                <strong>{id === "default" ? "默认私钥" : `身份 ${id}`}</strong>
                <small>
                  用于：
                  {rows
                    .filter(
                      (r) =>
                        r.record?.authMethod === "publicKey" &&
                        !r.record.keyPath &&
                        (r.identityId ?? "default") === id,
                    )
                    .map((r) => r.record!.name)
                    .join("、")}
                </small>
                <div className="import-key-modes">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-pressed={!keyModes[id]}
                    onClick={() =>
                      setKeyModes((prev) => ({ ...prev, [id]: false }))
                    }
                  >
                    选择文件
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-pressed={!!keyModes[id]}
                    onClick={() =>
                      setKeyModes((prev) => ({ ...prev, [id]: true }))
                    }
                  >
                    粘贴私钥
                  </Button>
                </div>
                {keyModes[id] ? (
                  <Textarea
                    aria-label={`${id === "default" ? "默认私钥" : `身份 ${id}`}正文`}
                    value={keyContents[id] ?? ""}
                    disabled={busy}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={
                      "-----BEGIN OPENSSH PRIVATE KEY-----\n在这里粘贴完整私钥，包含 BEGIN 和 END 行\n-----END OPENSSH PRIVATE KEY-----"
                    }
                    onChange={(e) =>
                      setKeyContents((prev) => ({
                        ...prev,
                        [id]: e.target.value,
                      }))
                    }
                  />
                ) : (
                  <div className="import-key-file">
                    <Input
                      aria-label={id === "default" ? "默认私钥" : `身份 ${id}`}
                      disabled={busy}
                      value={keys[id] ?? ""}
                      onChange={(e) =>
                        setKeys((prev) => ({ ...prev, [id]: e.target.value }))
                      }
                      placeholder="选择或填写本机私钥路径"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={async () => {
                        try {
                          const path = await open({
                            multiple: false,
                            directory: false,
                          });
                          if (typeof path === "string")
                            setKeys((prev) => ({ ...prev, [id]: path }));
                        } catch {
                          setMessage(
                            "无法打开文件选择器，请手动填写私钥路径。",
                          );
                        }
                      }}
                    >
                      浏览文件
                    </Button>
                  </div>
                )}
                <Input
                  type="password"
                  autoComplete="new-password"
                  aria-label={`${id === "default" ? "默认私钥" : `身份 ${id}`}口令`}
                  placeholder="私钥口令（仅加密私钥需要）"
                  disabled={busy}
                  value={passphrases[id] ?? ""}
                  onChange={(e) =>
                    setPassphrases((prev) => ({
                      ...prev,
                      [id]: e.target.value,
                    }))
                  }
                />
              </section>
            ))}
            <div className="import-preview">
              <table>
                <thead>
                  <tr>
                    <th>行</th>
                    <th>名称 / 连接</th>
                    <th>认证</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map(({ row, status }) => (
                    <tr key={row.line}>
                      <td>{row.line}</td>
                      <td>
                        {row.record?.name ?? "—"}
                        <small>
                          {row.record &&
                            `${row.record.username}@${row.record.host}:${row.record.port}`}
                        </small>
                      </td>
                      <td>
                        {row.record
                          ? row.record.authMethod === "password"
                            ? "密码"
                            : row.identityId
                              ? "身份私钥"
                              : "私钥"
                          : "—"}
                      </td>
                      <td>
                        {row.record && failed.has(row.record.id)
                          ? "保存失败，可重试"
                          : status}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p role="status">
              {message ||
                `${rows.length} 行，${ready.length} 个可导入。重复连接按地址、端口和用户名判断。`}
            </p>
            <div className="import-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={close}
              >
                关闭
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setRows([]);
                  setSaved(new Set());
                  setFailed(new Set());
                  setMessage("");
                }}
              >
                重新粘贴
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !ready.length}
                onClick={save}
              >
                {busy ? "正在导入…" : `导入 ${ready.length} 个连接`}
              </Button>
            </div>
          </>
        )}
      </div>
    </AppDialog>
  );
}
