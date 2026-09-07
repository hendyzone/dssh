//! 服务器条目持久化：基础信息存 JSON（app_config_dir），密码/passphrase 存系统 keyring
//!
//! 安全模型：条目 JSON 里只存 has_password/has_passphrase 标志，密钥永不出后端。

use std::fs;

use serde::{Deserialize, Serialize};
use crate::runtime::{AppHandle};

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

pub(crate) fn servers_file(app: &AppHandle) -> Result<std::path::PathBuf, ServersError> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| ServersError::Other(e.to_string()))?;
    fs::create_dir_all(&dir).map_err(|e| ServersError::Other(e.to_string()))?;
    Ok(dir.join("servers.json"))
}

pub(crate) fn read_all(app: &AppHandle) -> Result<Vec<ServerRecord>, ServersError> {
    let path = servers_file(app)?;
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| ServersError::Other(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| ServersError::Other(format!("servers.json 损坏: {e}")))
}

pub(crate) fn write_all(app: &AppHandle, servers: &[ServerRecord]) -> Result<(), ServersError> {
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

pub(crate) fn set_secret(server_id: &str, kind: &str, value: &str) -> Result<(), ServersError> {
    let account = format!("{server_id}:{kind}");
    keyring::Entry::new(KEYRING_SERVICE, &account)
        .and_then(|e| e.set_password(value))
        .map_err(|e| ServersError::Other(format!("keyring 写入失败: {e}")))
}

pub(crate) fn delete_secret(server_id: &str, kind: &str) {
    let account = format!("{server_id}:{kind}");
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &account) {
        let _ = entry.delete_credential();
    }
}

// ---- Desktop commands ----

fn validate_pasted_key(content: &str, passphrase: Option<&str>) -> Result<String, ServersError> {
    if content.len() > 128 * 1024 {
        return Err(ServersError::Other("私钥内容过长".into()));
    }
    let normalized = format!("{}\n", content.trim().replace("\r\n", "\n"));
    russh::keys::decode_secret_key(&normalized, passphrase).map_err(|_| {
        ServersError::Other("私钥格式无效或口令不正确，请粘贴完整私钥；加密私钥需填写口令".into())
    })?;
    Ok(normalized)
}

pub async fn servers_import_private_key(
    app: AppHandle,
    content: String,
    passphrase: Option<String>,
) -> Result<String, ServersError> {
    let normalized = validate_pasted_key(&content, passphrase.as_deref())?;
    let root = servers_file(&app)?.parent().unwrap().join("imported-keys");
    fs::create_dir_all(&root).map_err(|_| ServersError::Other("无法创建私钥目录".into()))?;
    crate::sync::bundle::restrict_directory(&root)
        .map_err(|_| ServersError::Other("无法保护私钥目录权限".into()))?;
    let path = root.join(format!("key-{:032x}", rand::random::<u128>()));
    if crate::sync::bundle::write_key(&path, normalized.as_bytes()).is_err() {
        return Err(ServersError::Other("无法保存私钥文件".into()));
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod pasted_key_tests {
    use super::*;

    #[test]
    fn groups_only_ungrouped_connections_and_preserves_credentials() {
        let make = |id: &str, group: Option<&str>| {
            serde_json::from_value::<ServerRecord>(serde_json::json!({
                "id": id, "name": id, "host": "Example.COM", "port": 22,
                "username": "u", "authMethod": "publicKey", "keyPath": "synthetic-path",
                "hasPassphrase": true, "group": group
            }))
            .unwrap()
        };
        let mut records = vec![
            make("1", None),
            make("2", None),
            make("3", Some("公司/生产")),
        ];
        auto_group(&mut records);
        assert_eq!(records[0].group.as_deref(), Some("按地址分组/example.com"));
        assert_eq!(records[0].group, records[1].group);
        assert_eq!(records[2].group.as_deref(), Some("公司/生产"));
        assert!(records
            .iter()
            .all(|s| s.has_passphrase && s.key_path.as_deref() == Some("synthetic-path")));
        let before = serde_json::to_string(&records).unwrap();
        auto_group(&mut records);
        assert_eq!(before, serde_json::to_string(&records).unwrap());
    }

    #[test]
    fn accepts_generated_keys_and_preserves_encryption() {
        use russh::keys::{ssh_key::LineEnding, Algorithm, PrivateKey};
        let key = PrivateKey::random(&mut rand::thread_rng(), Algorithm::Ed25519).unwrap();
        let plain = key.to_openssh(LineEnding::CRLF).unwrap();
        assert!(validate_pasted_key(&plain, None).is_ok());
        let encrypted = key
            .encrypt(&mut rand::thread_rng(), "synthetic-test-passphrase")
            .unwrap();
        let encoded = encrypted.to_openssh(LineEnding::LF).unwrap();
        assert!(validate_pasted_key(&encoded, Some("wrong")).is_err());
        let normalized = validate_pasted_key(&encoded, Some("synthetic-test-passphrase")).unwrap();
        assert!(PrivateKey::from_openssh(normalized).unwrap().is_encrypted());
    }

    #[test]
    fn rejects_invalid_and_oversized_private_keys_without_echoing_content() {
        for content in [
            "secret-invalid-value".to_owned(),
            "x".repeat(128 * 1024 + 1),
        ] {
            let message = validate_pasted_key(&content, None).unwrap_err().to_string();
            assert!(!message.contains(&content));
        }
        assert!(validate_pasted_key("ssh-ed25519 AAAA public-key", None).is_err());
    }
}

pub async fn servers_list(app: AppHandle) -> Result<Vec<ServerRecord>, ServersError> {
    read_all(&app)
}

pub(crate) fn export_secret(server_id: &str, kind: &str) -> Result<Option<String>, ServersError> {
    match keyring::Entry::new(KEYRING_SERVICE, &format!("{server_id}:{kind}"))
        .and_then(|entry| entry.get_password())
    {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(ServersError::Other(
            "无法读取系统凭据库，已停止完整备份".into(),
        )),
    }
}

/// Move a saved connection without rewriting credentials or forwarding rules.
fn auto_group(records: &mut [ServerRecord]) {
    for record in records {
        if record.group.as_deref().unwrap_or("").trim().is_empty() {
            let host: String = record
                .host
                .trim()
                .to_lowercase()
                .chars()
                .map(|c| {
                    if c == '/' || c == '\\' || c.is_control() {
                        '_'
                    } else {
                        c
                    }
                })
                .collect();
            if !host.is_empty() {
                record.group = Some(format!("按地址分组/{host}"));
            }
        }
    }
}

pub async fn servers_auto_group(app: AppHandle) -> Result<Vec<ServerRecord>, ServersError> {
    let mut records = read_all(&app)?;
    auto_group(&mut records);
    write_all(&app, &records)?;
    Ok(records)
}

pub async fn servers_move(
    app: AppHandle,
    id: String,
    group: Option<String>,
) -> Result<Vec<ServerRecord>, ServersError> {
    let mut all = read_all(&app)?;
    let record = all
        .iter_mut()
        .find(|record| record.id == id)
        .ok_or_else(|| ServersError::Other("连接已不存在，请刷新列表".into()))?;
    record.group = group.filter(|value| !value.is_empty());
    write_all(&app, &all)?;
    Ok(all)
}

/// 新增/更新服务器。password/passphrase 为 Some 时更新 keyring（空字符串表示清除）。
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
/// 该函数不直接暴露给桌面 IPC，前端通过 forward_rules_list 调用。
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

pub async fn servers_delete(app: AppHandle, id: String) -> Result<(), ServersError> {
    delete_secret(&id, "password");
    delete_secret(&id, "passphrase");
    let mut all = read_all(&app)?;
    all.retain(|s| s.id != id);
    write_all(&app, &all)
}

fn clone_record(source: &ServerRecord, all: &[ServerRecord]) -> ServerRecord {
    use rand::RngCore;
    let fresh = || {
        let mut bytes = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        bytes.iter().map(|v| format!("{v:02x}")).collect::<String>()
    };
    let mut record = source.clone();
    record.id = fresh();
    let base = format!("{} 副本", source.name);
    record.name = base.clone();
    let mut n = 2;
    while all
        .iter()
        .any(|s| s.group == record.group && s.name == record.name)
    {
        record.name = format!("{base} {n}");
        n += 1;
    }
    for rule in &mut record.forwards {
        rule.id = fresh();
    }
    record
}

pub async fn servers_clone(app: AppHandle, id: String) -> Result<Vec<ServerRecord>, ServersError> {
    let mut all = read_all(&app)?;
    let source = all
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| ServersError::Other("连接已不存在".into()))?;
    let mut record = clone_record(source, &all);
    let password = export_secret(&id, "password")
        .map_err(|_| ServersError::Other("无法读取凭据，克隆已停止".into()))?;
    let passphrase = export_secret(&id, "passphrase")
        .map_err(|_| ServersError::Other("无法读取凭据，克隆已停止".into()))?;
    if (source.has_password && password.is_none())
        || (source.has_passphrase && passphrase.is_none())
    {
        return Err(ServersError::Other(
            "原连接的已保存凭据缺失，请重新保存后克隆".into(),
        ));
    }
    record.has_password = password.is_some();
    record.has_passphrase = passphrase.is_some();
    let new_id = record.id.clone();
    let result = (|| {
        if let Some(value) = password {
            set_secret(&new_id, "password", &value)?;
        }
        if let Some(value) = passphrase {
            set_secret(&new_id, "passphrase", &value)?;
        }
        all.push(record);
        write_all(&app, &all)
    })();
    if let Err(error) = result {
        delete_secret(&new_id, "password");
        delete_secret(&new_id, "passphrase");
        return Err(error);
    }
    Ok(all)
}

#[cfg(test)]
mod clone_tests {
    use super::*;
    #[test]
    fn clone_preserves_configuration_and_uses_independent_identifiers() {
        let source: ServerRecord = serde_json::from_value(serde_json::json!({"id":"source","name":"Demo","host":"example.test","port":22,"username":"demo","group":"A/B","authMethod":"publicKey","keyPath":"demo-key","hasPassphrase":true,"forwards":[{"id":"rule","ruleType":"local","localHost":"127.0.0.1","localPort":8080,"remoteHost":"localhost","remotePort":80,"enabled":true,"autoStart":false}]})).unwrap();
        let first = clone_record(&source, &[source.clone()]);
        let second = clone_record(&source, &[source.clone(), first.clone()]);
        assert_eq!(first.name, "Demo 副本");
        assert_eq!(second.name, "Demo 副本 2");
        assert_ne!(first.id, source.id);
        assert_ne!(first.id, second.id);
        assert_ne!(first.forwards[0].id, source.forwards[0].id);
        assert_eq!(first.group, source.group);
        assert_eq!(first.key_path, source.key_path);
        assert_eq!(first.forwards[0].rule.local_port, 8080);
    }
}
