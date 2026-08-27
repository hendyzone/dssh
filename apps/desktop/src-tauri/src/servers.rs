//! 服务器条目持久化：基础信息存 JSON（app_config_dir），密码/passphrase 存系统 keyring
//!
//! 安全模型：条目 JSON 里只存 has_password/has_passphrase 标志，密钥永不出后端。

use std::fs;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
        Some(existing) => *existing = record.clone(),
        None => all.push(record.clone()),
    }
    write_all(&app, &all)?;
    Ok(record)
}

#[tauri::command]
pub async fn servers_delete(app: AppHandle, id: String) -> Result<(), ServersError> {
    delete_secret(&id, "password");
    delete_secret(&id, "passphrase");
    let mut all = read_all(&app)?;
    all.retain(|s| s.id != id);
    write_all(&app, &all)
}
