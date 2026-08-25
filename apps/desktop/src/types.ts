export interface ServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group?: string;
  authMethod: "password" | "publicKey";
  /** 密码（authMethod=password）。临时方案：localStorage 明文，M2 迁移到系统 keyring */
  password?: string;
  /** 私钥路径（authMethod=publicKey） */
  keyPath?: string;
  /** 私钥 passphrase（可选） */
  passphrase?: string;
}

export interface SessionInfo {
  /** 前端本地 id，与后端 session_id 不同（后者由 ssh_connect 返回） */
  id: string;
  server: ServerEntry;
}
