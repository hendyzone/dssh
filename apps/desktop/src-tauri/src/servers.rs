//! 服务器条目持久化：基础信息存 JSON（app_config_dir），密码/passphrase 存系统 keyring
//!
//! 安全模型：条目 JSON 里只存 has_password/has_passphrase 标志，密钥永不出后端。

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::forward::PersistentForwardRule;

/// 服务器条目（前端 ServerEntry 对应；不含明文密钥）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRecord {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub group: Option<String>,
    /// password / publicKey
    pub auth_method: String,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub has_password: bool,
    #[serde(default)]
    pub has_passphrase: bool,
    /// 该服务器的端口转发规则；旧版本 servers.json 缺少此字段时使用空列表。
    #[serde(default)]
    pub forwards: Vec<PersistentForwardRule>,
}

#[derive(Debug, thiserror::Error)]
pub enum ServersError {
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for ServersError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

fn servers_file(app: &AppHandle) -> Result<std::path::PathBuf, ServersError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| ServersError::Other(e.to_string()))?;
    fs::create_dir_all(&dir).map_err(|e| ServersError::Other(e.to_string()))?;
    Ok(dir.join("servers.json"))
}

fn read_all(app: &AppHandle) -> Result<Vec<ServerRecord>, ServersError> {
    let path = servers_file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| ServersError::Other(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| ServersError::Other(format!("servers.json 损坏: {e}")))
}

fn write_all(app: &AppHandle, servers: &[ServerRecord]) -> Result<(), ServersError> {
    let path = servers_file(app)?;
    let raw =
        serde_json::to_string_pretty(servers).map_err(|e| ServersError::Other(e.to_string()))?;
    fs::write(&path, raw).map_err(|e| ServersError::Other(e.to_string()))
}

// ---- keyring ----

const KEYRING_SERVICE: &str = "dev.dssh.app";

/// 读取服务器密钥（kind: "password" | "passphrase"）。keyring 不可用/不存在时返回 None
pub fn get_secret(server_id: &str, kind: &str) -> Option<String> {
    let account = format!("{server_id}:{kind}");
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .ok()?
        .get_password()
        .ok()
}

fn set_secret(server_id: &str, kind: &str, value: &str) -> Result<(), ServersError> {
    let account = format!("{server_id}:{kind}");
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| ServersError::Other(format!("keyring 写入失败: {e}")))
}

fn delete_secret(server_id: &str, kind: &str) {
    let account = format!("{server_id}:{kind}");
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        let _ = entry.delete_credential();
    }
}

// ---- Tauri commands ----

#[tauri::command]
pub async fn servers_list(app: AppHandle) -> Result<Vec<ServerRecord>, ServersError> {
    read_all(&app)
}

/// 新增/更新服务器。password/passphrase 为 Some 时更新 keyring（空字符串表示清除）。
#[tauri::command]
pub async fn servers_upsert(
    app: AppHandle,
    mut record: ServerRecord,
    password: Option<String>,
    passphrase: Option<String>,
) -> Result<ServerRecord, ServersError> {
    // 密钥写入 keyring 并更新标志
    if let Some(pwd) = &password {
        if pwd.is_empty() {
            delete_secret(&record.id, "password");
            record.has_password = false;
        } else {
            set_secret(&record.id, "password", pwd)?;
            record.has_password = true;
        }
    }
    if let Some(pp) = &passphrase {
        if pp.is_empty() {
            delete_secret(&record.id, "passphrase");
            record.has_passphrase = false;
        } else {
            set_secret(&record.id, "passphrase", pp)?;
            record.has_passphrase = true;
        }
    }

    let mut all = read_all(&app)?;
    match all.iter_mut().find(|s| s.id == record.id) {
        Some(existing) => {
            // ServerForm 尚未携带 forwards，编辑服务器基础信息时保留已有规则。
            if record.forwards.is_empty() {
                record.forwards = existing.forwards.clone();
            }
            *existing = record.clone();
        }
        None => all.push(record.clone()),
    }
    write_all(&app, &all)?;
    Ok(record)
}

/// 读取服务器保存的转发规则，供转发命令使用。
///
/// 该函数不暴露为 Tauri command，前端通过 forward_rules_list 调用。
pub fn read_forwards(
    app: &AppHandle,
    server_id: &str,
) -> Result<Vec<PersistentForwardRule>, ServersError> {
    read_all(app)?
        .into_iter()
        .find(|server| server.id == server_id)
        .map(|server| server.forwards)
        .ok_or_else(|| ServersError::Other(format!("服务器不存在: {server_id}")))
}

/// 整体写入服务器的转发规则。
pub fn write_forwards(
    app: &AppHandle,
    server_id: &str,
    forwards: &[PersistentForwardRule],
) -> Result<(), ServersError> {
    let mut all = read_all(app)?;
    let server = all
        .iter_mut()
        .find(|server| server.id == server_id)
        .ok_or_else(|| ServersError::Other(format!("服务器不存在: {server_id}")))?;
    server.forwards = forwards.to_vec();
    write_all(app, &all)
}

#[tauri::command]
pub async fn servers_delete(app: AppHandle, id: String) -> Result<(), ServersError> {
    delete_secret(&id, "password");
    delete_secret(&id, "passphrase");
    let mut all = read_all(&app)?;
    all.retain(|s| s.id != id);
    write_all(&app, &all)
}
