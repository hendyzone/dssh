//! Full sync payload. Secrets never cross the frontend IPC boundary.
use super::SyncError;
use crate::servers::{self, ServerRecord};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::Write,
    path::Path,
};
use tauri::AppHandle;

pub const UI_KEYS: &[&str] = &[
    "dssh.settings",
    "dssh.sftp.hidden",
    "dssh.sftp.application",
    "dssh.sidebar.width",
    "dssh.sidebar.collapsed-groups",
    "dssh.sidebar.tree-layout",
    "dssh.panel-side.tmux",
    "dssh.panel-side.sftp",
    "dssh.panel-side.forward",
    "dssh.panel-side.tasks",
    "dssh.panel-side.changes",
    "dssh.panel-side.monitor",
];
pub type UiState = BTreeMap<String, String>;

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub record: ServerRecord,
    pub password: Option<String>,
    pub passphrase: Option<String>,
    pub private_key: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bundle {
    pub entries: Vec<Entry>,
    pub ui_state: UiState,
    #[serde(skip)]
    pub legacy: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub message: String,
    pub ui_state: UiState,
    pub legacy: bool,
}
fn error(message: &str) -> SyncError {
    SyncError::Other(message.into())
}
fn random_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn validate_ui(ui: &UiState) -> Result<(), SyncError> {
    for (key, value) in ui {
        if !UI_KEYS.contains(&key.as_str()) || value.len() > 512 * 1024 {
            return Err(error("界面配置无效或超过大小限制"));
        }
        if key == "dssh.sftp.application" {
            if value.len() > 4096 || value.contains('\0') {
                return Err(error("应用程序路径无效"));
            }
        } else if key == "dssh.sftp.hidden" {
            if value != "true" && value != "false" {
                return Err(error("隐藏文件设置无效"));
            }
        } else if key.starts_with("dssh.panel-side.") {
            if value != "left" && value != "right" {
                return Err(error("面板位置无效"));
            }
        } else {
            let parsed: serde_json::Value =
                serde_json::from_str(value).map_err(|_| error("界面配置格式无效"))?;
            match key.as_str() {
                "dssh.settings" => {
                    let size = parsed["fontSize"].as_u64().unwrap_or(0);
                    if !(10..=24).contains(&size)
                        || !parsed["themeId"].is_string()
                        || !parsed["fontFamily"].is_string()
                    {
                        return Err(error("主题或字体配置无效"));
                    }
                }
                "dssh.sidebar.width" => {
                    if !parsed.is_number() {
                        return Err(error("左栏宽度无效"));
                    }
                }
                "dssh.sidebar.collapsed-groups" => {
                    if !parsed
                        .as_array()
                        .is_some_and(|a| a.iter().all(|v| v.is_string()))
                    {
                        return Err(error("折叠状态无效"));
                    }
                }
                "dssh.sidebar.tree-layout" => {
                    if !parsed["folders"]
                        .as_array()
                        .is_some_and(|a| a.iter().all(|v| v.is_string()))
                        || !parsed["order"].as_object().is_some_and(|o| {
                            o.values().all(|v| {
                                v.as_array()
                                    .is_some_and(|a| a.iter().all(|v| v.is_string()))
                            })
                        })
                    {
                        return Err(error("文件夹配置无效"));
                    }
                }
                _ => {}
            }
        }
    }
    Ok(())
}
pub fn collect(app: &AppHandle, ui_state: UiState) -> Result<Bundle, SyncError> {
    validate_ui(&ui_state)?;
    let records = servers::read_all(app).map_err(|e| error(&e.to_string()))?;
    let mut entries = Vec::new();
    for record in records {
        let password =
            servers::export_secret(&record.id, "password").map_err(|e| error(&e.to_string()))?;
        let passphrase =
            servers::export_secret(&record.id, "passphrase").map_err(|e| error(&e.to_string()))?;
        if (record.has_password && password.is_none())
            || (record.has_passphrase && passphrase.is_none())
        {
            return Err(error(
                "有连接的已保存凭据无法读取，已停止上传；请补齐后重试",
            ));
        }
        let private_key = match record.key_path.as_deref().filter(|p| !p.is_empty()) {
            Some(path) => {
                let bytes = fs::read(path)
                    .map_err(|_| error("有连接的私钥文件无法读取，已停止上传；请检查私钥路径"))?;
                if bytes.len() > 128 * 1024 {
                    return Err(error("私钥文件超过 128 KB，请检查路径是否正确"));
                }
                Some(BASE64.encode(bytes))
            }
            None => None,
        };
        entries.push(Entry {
            record,
            password,
            passphrase,
            private_key,
        });
    }
    Ok(Bundle {
        entries,
        ui_state,
        legacy: false,
    })
}

pub(crate) fn restrict_directory(path: &Path) -> Result<(), SyncError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| error("无法限制私钥目录权限"))?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let user = std::env::var("USERNAME").map_err(|_| error("无法确定本机账户"))?;
        let domain = std::env::var("USERDOMAIN").map_err(|_| error("无法确定本机账户域"))?;
        let result = std::process::Command::new("icacls")
            .arg(path)
            .args([
                "/inheritance:r",
                "/grant:r",
                &format!("{domain}\\{user}:(OI)(CI)F"),
            ])
            .creation_flags(0x08000000)
            .output()
            .map_err(|_| error("无法设置私钥目录权限"))?;
        if !result.status.success() {
            return Err(error("无法限制私钥目录权限，恢复已停止"));
        }
    }
    Ok(())
}
pub(crate) fn write_key(path: &Path, bytes: &[u8]) -> Result<(), SyncError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| error("无法写入本机私钥文件"))?;
    file.write_all(bytes)
        .map_err(|_| error("无法保存本机私钥"))?;
    file.sync_all().map_err(|_| error("私钥文件保存失败"))
}

pub fn restore(app: &AppHandle, bundle: Bundle) -> Result<RestoreResult, SyncError> {
    let path = servers::servers_file(app).map_err(|e| error(&e.to_string()))?;
    restore_at(&path, bundle)
}

#[cfg(test)]
pub(crate) fn sample_bundle() -> Bundle {
    Bundle {
        entries: vec![Entry {
            record: ServerRecord {
                id: "synthetic-source".into(),
                name: "Test".into(),
                host: "example.invalid".into(),
                port: 22,
                username: "test".into(),
                group: Some("parent/child".into()),
                auth_method: "publicKey".into(),
                key_path: Some("/never/write/to/source-key".into()),
                has_password: true,
                has_passphrase: true,
                forwards: vec![],
            },
            password: Some("synthetic-ssh-password".into()),
            passphrase: Some("synthetic-key-passphrase".into()),
            private_key: Some(BASE64.encode(b"synthetic-private-key-bytes")),
        }],
        ui_state: BTreeMap::from([
            ("dssh.panel-side.tmux".into(), "left".into()),
            (
                "dssh.sidebar.tree-layout".into(),
                r#"{"folders":["empty/child"],"order":{"parent/child":["synthetic-source"]}}"#
                    .into(),
            ),
        ]),
        legacy: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unexpected_ui_keys_and_invalid_shapes() {
        assert!(validate_ui(&BTreeMap::from([(
            "github_pat".into(),
            "must-not-export".into()
        )]))
        .is_err());
        assert!(validate_ui(&BTreeMap::from([(
            "dssh.sidebar.tree-layout".into(),
            "[]".into()
        )]))
        .is_err());
        assert!(validate_ui(&sample_bundle().ui_state).is_ok());
    }
    #[test]
    #[ignore = "uses only synthetic temporary credentials and a generated temp directory"]
    fn full_sync_live_restore_credentials_and_files() {
        let dir = std::env::temp_dir().join(format!("dssh-sync-test-{}", random_id()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("servers.json");
        fs::write(&path, "[]").unwrap();
        let result = restore_at(&path, sample_bundle()).unwrap();
        let records: Vec<ServerRecord> = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let record = &records[0];
        assert_ne!(record.id, "synthetic-source");
        assert_eq!(
            servers::export_secret(&record.id, "password")
                .unwrap()
                .as_deref(),
            Some("synthetic-ssh-password")
        );
        assert_eq!(
            servers::export_secret(&record.id, "passphrase")
                .unwrap()
                .as_deref(),
            Some("synthetic-key-passphrase")
        );
        assert!(Path::new(record.key_path.as_ref().unwrap()).starts_with(dir.join("sync-keys")));
        assert_eq!(
            fs::read(record.key_path.as_ref().unwrap()).unwrap(),
            b"synthetic-private-key-bytes"
        );
        assert!(!String::from_utf8(fs::read(&path).unwrap())
            .unwrap()
            .contains("synthetic-ssh-password"));
        assert!(result.ui_state["dssh.sidebar.tree-layout"].contains(&record.id));
        assert_eq!(
            fs::read(path.with_file_name("servers.json.bak")).unwrap(),
            b"[]"
        );
        servers::delete_secret(&record.id, "password");
        servers::delete_secret(&record.id, "passphrase");
        let first_restore_dirs = fs::read_dir(dir.join("sync-keys")).unwrap().count();
        let invalid_destination = dir.join("directory-not-a-file");
        fs::create_dir(&invalid_destination).unwrap();
        assert!(restore_at(&invalid_destination, sample_bundle()).is_err());
        assert_eq!(
            fs::read_dir(dir.join("sync-keys")).unwrap().count(),
            first_restore_dirs
        );
        // Generated test directory only; never a user-provided or backup-provided path.
        assert!(dir.starts_with(std::env::temp_dir()));
        fs::remove_dir_all(&dir).unwrap();
    }
}

fn restore_at(path: &Path, mut bundle: Bundle) -> Result<RestoreResult, SyncError> {
    validate_ui(&bundle.ui_state)?;
    let mut ids = HashSet::new();
    let mut keys = Vec::new();
    for entry in &bundle.entries {
        if entry.record.id.is_empty() || !ids.insert(entry.record.id.clone()) {
            return Err(error("备份包含重复或无效的连接 ID"));
        }
        keys.push(
            entry
                .private_key
                .as_ref()
                .map(|key| BASE64.decode(key).map_err(|_| error("私钥备份格式无效")))
                .transpose()?,
        );
    }
    if bundle.legacy {
        for entry in &mut bundle.entries {
            entry.record.has_password = servers::get_secret(&entry.record.id, "password").is_some();
            entry.record.has_passphrase =
                servers::get_secret(&entry.record.id, "passphrase").is_some();
        }
    }
    let root = path.parent().unwrap().join("sync-keys");
    fs::create_dir_all(&root).map_err(|_| error("无法创建私钥存储目录"))?;
    let directory = root.join(random_id());
    fs::create_dir(&directory).map_err(|_| error("无法创建恢复目录"))?;
    let mut new_ids = Vec::new();
    let result = (|| {
        restrict_directory(&directory)?;
        let mut id_map = BTreeMap::new();
        for (index, entry) in bundle.entries.iter_mut().enumerate() {
            if bundle.legacy {
                continue;
            }
            // Stage under fresh IDs so a failed restore cannot overwrite live credentials.
            let id = format!("sync-{}", random_id());
            id_map.insert(entry.record.id.clone(), id.clone());
            new_ids.push(id.clone());
            if let Some(value) = &entry.password {
                servers::set_secret(&id, "password", value)
                    .map_err(|_| error("无法恢复 SSH 密码到系统凭据库"))?;
            }
            if let Some(value) = &entry.passphrase {
                servers::set_secret(&id, "passphrase", value)
                    .map_err(|_| error("无法恢复私钥口令到系统凭据库"))?;
            }
            entry.record.id = id;
            entry.record.has_password = entry.password.is_some();
            entry.record.has_passphrase = entry.passphrase.is_some();
            if let Some(bytes) = &keys[index] {
                let key_path = directory.join(format!("key-{index}"));
                write_key(&key_path, bytes)?;
                entry.record.key_path = Some(key_path.to_string_lossy().into_owned());
            } else {
                entry.record.key_path = None;
            }
        }
        if let Some(raw) = bundle.ui_state.get_mut("dssh.sidebar.tree-layout") {
            let mut layout: serde_json::Value =
                serde_json::from_str(raw).map_err(|_| error("文件夹配置无效"))?;
            if let Some(order) = layout["order"].as_object_mut() {
                for value in order.values_mut() {
                    if let Some(list) = value.as_array_mut() {
                        for id in list {
                            if let Some(replacement) = id.as_str().and_then(|id| id_map.get(id)) {
                                *id = serde_json::Value::String(replacement.clone());
                            }
                        }
                    }
                }
            }
            *raw = serde_json::to_string(&layout).map_err(|_| error("文件夹配置无法恢复"))?;
        }
        if path.exists() {
            fs::copy(&path, path.with_file_name("servers.json.bak"))
                .map_err(|_| error("备份本机连接列表失败，未替换列表"))?;
        }
        let records: Vec<_> = bundle
            .entries
            .iter()
            .map(|entry| entry.record.clone())
            .collect();
        // Write and flush staging data before replacing the connection list.
        let staged = directory.join("servers.json");
        let raw = serde_json::to_vec_pretty(&records).map_err(|_| error("连接列表无法保存"))?;
        write_key(&staged, &raw)?;
        fs::rename(&staged, &path).map_err(|_| error("无法替换本机连接列表"))?;
        Ok(RestoreResult {
            message: format!(
                "已恢复 {} 个连接{}",
                records.len(),
                if bundle.legacy {
                    "（旧版备份不含密码、私钥与界面配置）"
                } else {
                    "及登录凭据、私钥和界面配置"
                }
            ),
            ui_state: bundle.ui_state.clone(),
            legacy: bundle.legacy,
        })
    })();
    if result.is_err() {
        for id in new_ids {
            servers::delete_secret(&id, "password");
            servers::delete_secret(&id, "passphrase");
        }
        // Only the fresh, generated child of sync-keys is removed; no source paths are used.
        let _ = fs::remove_dir_all(&directory);
    }
    result
}
