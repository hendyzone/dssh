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
  /** 该服务器保存的端口转发规则 */
  forwards?: ForwardRuleDefinition[];
}

/** 服务器条目中的持久化端口转发规则 */
export interface ForwardRuleDefinition {
  id: string;
  ruleType: "local" | "remote" | "dynamic";
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  enabled: boolean;
  autoStart: boolean;
}

export interface SessionInfo {
  /** 前端本地 id，与后端 session_id 不同（后者由 ssh_connect 返回） */
  id: string;
  server: ServerEntry;
  /** Stable remote identity prevents reconnecting to a reused tmux session ID. */
  tmux?: { id: string; created: number; name: string };
}

/** 一个标签页：1-2 个窗格（分屏） */
export interface TabInfo {
  id: string;
  /** 当前窗口内已打开连接的分组 */
  groupId?: string;
  /** 用户自定义标签名；未设置时显示服务器名 */
  customTitle?: string;
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

/** GitHub 仓库连通性检查结果（PAT 不会返回到前端或界面回显）。 */
export interface SyncTestResult {
  repository: string;
  exists: boolean;
  private: boolean;
  fullName: string;
}
