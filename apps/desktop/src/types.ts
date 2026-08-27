/** 服务器条目（与后端 ServerRecord 对应，不含明文密钥） */
export interface ServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  group?: string;
  authMethod: "password" | "publicKey";
  keyPath?: string;
  /** 密码/passphrase 是否已存于系统 keyring */
  hasPassword?: boolean;
  hasPassphrase?: boolean;
}

export interface SessionInfo {
  /** 前端本地 id，与后端 session_id 不同（后者由 ssh_connect 返回） */
  id: string;
  server: ServerEntry;
}

/** 一个标签页：1-2 个窗格（分屏） */
export interface TabInfo {
  id: string;
  panes: SessionInfo[];
  /** 分屏方向；undefined = 单窗格 */
  splitDir?: "row" | "column";
  /** 当前聚焦的窗格下标 */
  activePane: number;
}

export interface AppSettings {
  themeId: string;
  fontSize: number;
  fontFamily: string;
}
