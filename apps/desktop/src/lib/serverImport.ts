import type { ServerEntry } from "../types";

export interface ImportRow {
  line: number;
  record?: ServerEntry;
  password?: string;
  identityId?: string;
  error?: string;
}

// Parse data only: quotes delimit values; backslashes in Windows paths remain literal.
function fields(line: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let i = 0;
  while (i < line.length) {
    while (/\s/.test(line[i] ?? "") && i < line.length) i++;
    if (i === line.length) break;
    const match = /^[A-Za-z][A-Za-z0-9]*=/.exec(line.slice(i));
    if (!match) throw new Error("字段格式应为 key=value；包含空格的值请加引号");
    const key = match[0].slice(0, -1);
    if (key in result) throw new Error("存在重复字段");
    i += match[0].length;
    let value = "";
    const quote = line[i] === '"' || line[i] === "'" ? line[i++] : null;
    if (quote) {
      while (i < line.length && line[i] !== quote) {
        if (line[i] === "\\" && line[i + 1] === quote) i++;
        value += line[i++];
      }
      if (line[i++] !== quote) throw new Error("引号未闭合");
      if (i < line.length && !/\s/.test(line[i]))
        throw new Error("字段之间需要空格");
    } else {
      while (i < line.length && !/\s/.test(line[i])) value += line[i++];
    }
    result[key] = value;
  }
  return result;
}

export function endpoint(server: ServerEntry): string {
  return JSON.stringify([
    server.host.toLowerCase(),
    server.port,
    server.username,
  ]);
}

export function parseServerImport(input: string): ImportRow[] {
  return input.split(/\r?\n/).flatMap((line, index): ImportRow[] => {
    if (!line.trim() || line.trimStart().startsWith("#")) return [];
    try {
      const f = fields(line.trim());
      const allowed = new Set([
        "host",
        "port",
        "user",
        "authType",
        "password",
        "title",
        "identityId",
        "keyPath",
        "group",
      ]);
      if (Object.keys(f).some((key) => !allowed.has(key)))
        throw new Error("包含不支持的字段");
      if (!f.host || /[\s/]/.test(f.host)) throw new Error("服务器地址无效");
      if (!f.user || /\s/.test(f.user)) throw new Error("用户名无效");
      const port = f.port ?? "22";
      if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
        throw new Error("端口须为 1–65535 的整数");
      if (!["password", "privateKey", "identity"].includes(f.authType))
        throw new Error("authType 须为 password、privateKey 或 identity");
      if (f.authType === "identity" && !f.identityId)
        throw new Error("identity 认证缺少 identityId");
      return [
        {
          line: index + 1,
          record: {
            id: crypto.randomUUID(),
            name: f.title || f.host,
            host: f.host,
            port: Number(port),
            username: f.user,
            group: f.group || undefined,
            authMethod: f.authType === "password" ? "password" : "publicKey",
            keyPath: f.keyPath || undefined,
          },
          password: f.authType === "password" ? f.password : undefined,
          identityId: f.authType === "identity" ? f.identityId : undefined,
        },
      ];
    } catch (e) {
      return [
        {
          line: index + 1,
          error: e instanceof Error ? e.message : "无法解析此行",
        },
      ];
    }
  });
}
