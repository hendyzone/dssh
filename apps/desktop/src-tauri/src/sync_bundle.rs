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
use tauri::{AppHandle, Manager};

pub const UI_KEYS: &[&str] = &[
    "dssh.task-lookup.v1",
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
    "dssh.panel-side.team",
    "dssh.panel-side.collaboration",
    "dssh.collaboration.v2",
    "dssh.team-connections.v1",
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_service: Option<crate::team_service::sync_config::Backup>,
    pub entries: Vec<Entry>,
    pub ui_state: UiState,
    #[serde(default)]
    pub ai_keys: BTreeMap<String, String>,
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

fn team_lock_identity_valid(raw: &str) -> bool {
    if raw.len() > 4096 { return false; }
    let Ok(parts) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else { return false; };
    if parts.len() != 3 || !parts[2].as_str().is_some_and(crate::taskboard::identifier) { return false; }
    let Some(identity) = parts[1].as_str() else { return false; };
    match parts[0].as_str() {
        Some("service") => crate::taskboard::board_url(identity).is_ok_and(|url| {
            url.as_str() == identity && url.path().ends_with("/api/v1")
        }),
        Some("legacy") => {
            let Ok(lead) = serde_json::from_str::<Vec<serde_json::Value>>(identity) else { return false; };
            let text = |index: usize, max: usize| lead.get(index).and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control));
            lead.len() == 5 && text(0, 1024) && text(2, 256) && text(3, 4096) && text(4, 256)
                && lead[0].as_str().is_some_and(|host| host == host.trim().to_lowercase())
                && lead[1].as_u64().is_some_and(|port| (1..=65535).contains(&port))

        }
        _ => false,
    }
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
                "dssh.task-lookup.v1" => {
                    let url = parsed["boardUrl"].as_str().ok_or_else(|| error("看板地址格式无效"))?;
                    if !url.trim().is_empty() && crate::taskboard::board_url(url).is_err() {
                        return Err(error("看板地址无效"));
                    }
                    let project = parsed["lockedProject"].as_str().ok_or_else(|| error("锁定项目格式无效"))?;
                    if (!project.is_empty() && !crate::taskboard::identifier(project)) || !parsed["terminalLinks"].is_boolean() {
                        return Err(error("任务查询配置无效"));
                    }
                    if let Some(locks) = parsed.get("teamLocks") {
                        let locks = locks.as_object().filter(|locks| locks.len() <= 256)
                            .ok_or_else(|| error("团队锁定配置格式无效"))?;
                        for (identity, project) in locks {
                            if !team_lock_identity_valid(identity) || !project.as_str().is_some_and(|project| project.is_empty() || crate::taskboard::identifier(project)) {
                                return Err(error("团队锁定配置无效"));
                            }
                        }
                    }
                    let overrides = parsed["overrides"].as_object().ok_or_else(|| error("项目绑定格式无效"))?;
                    for (key, value) in overrides {
                        if !(key.starts_with("server:") || key.starts_with("tmux:"))
                            || !value.as_str().is_some_and(crate::taskboard::identifier) {
                            return Err(error("项目绑定无效"));
                        }
                    }
                }
                "dssh.settings" => {
                    let size = parsed["fontSize"].as_u64().unwrap_or(0);
                    if !(10..=24).contains(&size)
                        || !parsed["themeId"].is_string()
                        || !parsed["fontFamily"].is_string()
                    {
                        return Err(error("主题或字体配置无效"));
                    }
                }
                "dssh.collaboration.v2" => {
                    let profiles = parsed.as_object().ok_or_else(|| error("团队绑定格式无效"))?;
                    for (key, profile) in profiles {
                        let identity: Vec<serde_json::Value> = serde_json::from_str(key)
                            .map_err(|_| error("团队绑定身份无效"))?;
                        if identity.len() != 4 || !identity[0].is_string()
                            || !identity[1].is_string() || !identity[2].is_u64()
                            || !identity[3].is_string() || !profile.is_object() {
                            return Err(error("团队绑定身份无效"));
                        }
                    }
                }
                "dssh.team-connections.v1" => {
                    if !parsed.as_object().is_some_and(|m| m.values().all(|v| v.is_string())) {
                        return Err(error("成员连接映射无效"));
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
pub async fn collect(app: &AppHandle, mut ui_state: UiState) -> Result<Bundle, SyncError> {
    strip_retired_ai(&mut ui_state);
    validate_ui(&ui_state)?;
    let team_service = app.state::<crate::team_service::TeamService>().backup().await.map_err(|_| error("无法读取团队服务配置或凭据，已停止备份"))?;
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
        team_service,
        entries,
        ai_keys: BTreeMap::new(),
        ui_state,
        legacy: false,
    })
}

fn remap_team_connections(ui: &mut UiState, ids: &BTreeMap<String, String>) -> Result<(), SyncError> {
    if let Some(raw) = ui.get_mut("dssh.task-lookup.v1") {
        let mut settings: serde_json::Value = serde_json::from_str(raw).map_err(|_| error("任务查询配置无效"))?;
        let overrides = settings["overrides"].as_object().ok_or_else(|| error("项目绑定格式无效"))?;
        let mut mapped = serde_json::Map::new();
        for (key, value) in overrides {
            let mut parts = key.splitn(3, ':');
            let kind = parts.next().unwrap_or("");
            let source = parts.next().unwrap_or("");
            if let Some(id) = ids.get(source) {
                let target = match (kind, parts.next()) {
                    ("server", None) => format!("server:{id}"),
                    ("tmux", Some(name)) => format!("tmux:{id}:{name}"),
                    _ => continue,
                };
                mapped.insert(target, value.clone());
            }
        }
        settings["overrides"] = serde_json::Value::Object(mapped);
        *raw = settings.to_string();
    }
    if let Some(raw) = ui.get_mut("dssh.collaboration.v2") {
        let profiles: BTreeMap<String, serde_json::Value> = serde_json::from_str(raw)
            .map_err(|_| error("团队绑定格式无效"))?;
        let mut mapped = BTreeMap::new();
        for (key, profile) in profiles {
            let mut identity: Vec<serde_json::Value> = serde_json::from_str(&key)
                .map_err(|_| error("团队绑定身份无效"))?;
            if let Some(id) = identity.first().and_then(|v| v.as_str()).and_then(|id| ids.get(id)) {
                identity[0] = serde_json::Value::String(id.clone());
                mapped.insert(serde_json::to_string(&identity).map_err(|_| error("团队绑定无法恢复"))?, profile);
            }
        }
        *raw = serde_json::to_string(&mapped).map_err(|_| error("团队绑定无法恢复"))?;
    }
    if let Some(raw) = ui.get_mut("dssh.team-connections.v1") {
        let mappings: BTreeMap<String, String> = serde_json::from_str(raw)
            .map_err(|_| error("成员连接映射无效"))?;
        let mapped: BTreeMap<_, _> = mappings.into_iter()
            .filter_map(|(key, id)| ids.get(&id).map(|replacement| (key, replacement.clone())))
            .collect();
        *raw = serde_json::to_string(&mapped).map_err(|_| error("成员连接映射无法恢复"))?;
    }
    Ok(())
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

fn strip_retired_ai(ui: &mut UiState) {
    ui.remove("dssh.team-ai.v1");
    ui.remove("dssh.team-ai.profiles.v1");
}

pub async fn restore(app: &AppHandle, bundle: Bundle) -> Result<RestoreResult, SyncError> {
    let path = servers::servers_file(app).map_err(|e| error(&e.to_string()))?;
    app.state::<crate::team_service::TeamService>().restore_sync(path, bundle).await
}

#[cfg(test)]
pub(crate) fn sample_bundle() -> Bundle {
    Bundle {
        team_service: None,
        ai_keys: BTreeMap::new(),
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
    #[test]
    fn task_lookup_sync_validates_and_remaps_server_bindings() {
        let mut ui = std::collections::BTreeMap::from([("dssh.task-lookup.v1".into(), serde_json::json!({
            "boardUrl":"http://board.test:8091/", "terminalLinks":false, "lockedProject":"demo",
            "overrides":{"server:old":"demo","tmux:old:lead:one":"docs","server:missing":"unused"}
        }).to_string())]);
        super::validate_ui(&ui).unwrap();
        super::remap_team_connections(&mut ui, &std::collections::BTreeMap::from([("old".into(),"new".into())])).unwrap();
        let settings: serde_json::Value = serde_json::from_str(&ui["dssh.task-lookup.v1"]).unwrap();
        assert_eq!(settings["overrides"], serde_json::json!({"server:new":"demo","tmux:new:lead:one":"docs"}));
        assert_eq!(settings["terminalLinks"], false);
        let mut bad = settings;
        bad["boardUrl"] = "javascript:alert(1)".into();
        ui.insert("dssh.task-lookup.v1".into(), bad.to_string());
        assert!(super::validate_ui(&ui).is_err());
    }
    use super::*;
    #[test]
    fn retired_ai_fields_are_ignored_even_when_malformed() {
        let mut bundle = sample_bundle();
        bundle.entries.clear();
        bundle.ui_state.clear();
        bundle.ui_state.insert("dssh.team-ai.v1".into(), "not-json".into());
        bundle.ui_state.insert("dssh.team-ai.profiles.v1".into(), "also-not-json".into());
        bundle.ai_keys.insert("invalid".into(), "old-secret".into());
        assert!(!UI_KEYS.contains(&"dssh.team-ai.v1"));
        assert!(!UI_KEYS.contains(&"dssh.team-ai.profiles.v1"));
        let dir = std::env::temp_dir().join(format!("sync-retired-{}", random_id()));
        fs::create_dir(&dir).unwrap();
        let result = restore_at(&dir.join("servers.json"), bundle).unwrap();
        assert!(result.ui_state.is_empty());
        fs::remove_dir_all(dir).unwrap();
        let mut json = serde_json::to_value(sample_bundle()).unwrap();
        json.as_object_mut().unwrap().remove("teamService");
        assert!(serde_json::from_value::<Bundle>(json).unwrap().team_service.is_none());
    }
    #[test]
    fn team_locks_validate_boundaries_and_preserve_global_and_explicit_unlock() {
        let service = serde_json::json!(["service", "https://team.example.invalid/api/v1", "demo"]).to_string();
        let legacy = serde_json::json!(["legacy", serde_json::json!(["host.example.invalid",22,"user","/repo","lead"]).to_string(), "legacy-project"]).to_string();
        let original = serde_json::json!({"boardUrl":"", "terminalLinks":true, "lockedProject":"global-project", "overrides":{"server:old":"global-project"}, "teamLocks":{service.clone():"",legacy.clone():"legacy-board"}});
        let ui_for = |value: &serde_json::Value| BTreeMap::from([("dssh.task-lookup.v1".into(),value.to_string())]);
        let mut ui=ui_for(&original);
        validate_ui(&ui).unwrap();
        remap_team_connections(&mut ui,&BTreeMap::from([("old".into(),"new".into())])).unwrap();
        let remapped:serde_json::Value=serde_json::from_str(&ui["dssh.task-lookup.v1"]).unwrap();
        assert_eq!(remapped["teamLocks"],original["teamLocks"]);
        assert_eq!(remapped["lockedProject"],"global-project");
        assert_eq!(remapped["overrides"],serde_json::json!({"server:new":"global-project"}));
        let mut old=original.clone();old.as_object_mut().unwrap().remove("teamLocks");
        validate_ui(&ui_for(&old)).unwrap();
        for invalid in [serde_json::json!([]),serde_json::Value::Null,serde_json::json!({"__proto__":"demo"}),serde_json::json!({service.clone():42}),serde_json::json!({service.clone():"bad/project"})] {
            let mut value=original.clone();value["teamLocks"]=invalid;
            assert!(validate_ui(&ui_for(&value)).is_err());
        }
        for identity in [
            serde_json::json!(["service","https://user:secret@team.example.invalid/api/v1","demo"]).to_string(),
            serde_json::json!(["service","https://team.example.invalid/api/v1/","demo"]).to_string(),
            serde_json::json!(["service","https://team.example.invalid/api/v1?token=secret","demo"]).to_string(),
            serde_json::json!(["legacy",serde_json::json!(["host",0,"user","/repo","lead"]).to_string(),"demo"]).to_string(),
            serde_json::json!(["legacy",serde_json::json!(["host",22,"user","/repo",""]).to_string(),"demo"]).to_string(),
            "x".repeat(4097),
        ] {
            let mut value=original.clone();value["teamLocks"]=serde_json::json!({identity:"demo"});
            assert!(validate_ui(&ui_for(&value)).is_err());
        }
        let mut locks=serde_json::Map::new();
        for index in 0..256 { locks.insert(serde_json::json!(["service","https://team.example.invalid/api/v1",format!("project-{index}")]).to_string(),serde_json::json!("")); }
        let mut value=original.clone();value["teamLocks"]=serde_json::Value::Object(locks.clone());validate_ui(&ui_for(&value)).unwrap();
        locks.insert(service,serde_json::json!("demo"));value["teamLocks"]=serde_json::Value::Object(locks);
        assert!(validate_ui(&ui_for(&value)).is_err());
    }
    #[test]
    fn team_bindings_follow_restored_server_ids() {
        let old_key = r#"["source","$1",123,"/repo"]"#;
        let mut ui = BTreeMap::from([
            ("dssh.collaboration.v2".into(), serde_json::json!({old_key: {"project":"demo","tmuxId":"$1"}}).to_string()),
            ("dssh.team-connections.v1".into(), r#"{"member":"source","stale":"missing"}"#.into()),
        ]);
        assert!(validate_ui(&ui).is_ok());
        remap_team_connections(&mut ui, &BTreeMap::from([("source".into(),"restored".into())])).unwrap();
        let profiles: serde_json::Value = serde_json::from_str(&ui["dssh.collaboration.v2"]).unwrap();
        assert_eq!(profiles[r#"["restored","$1",123,"/repo"]"#]["project"], "demo");
        assert!(profiles.get(old_key).is_none());
        assert_eq!(ui["dssh.team-connections.v1"], r#"{"member":"restored"}"#);
        assert!(validate_ui(&BTreeMap::from([("dssh.collaboration.v2".into(), r#"{"bad":{}}"#.into())])).is_err());
    }
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
        let mut bundle = sample_bundle();
        bundle.ui_state.insert("dssh.team-ai.v1".into(), "retired-invalid-json".into());
        bundle.ai_keys.insert("old".into(), "retired-key".into());
        let result = restore_at(&path, bundle).unwrap();
        assert!(!result.ui_state.contains_key("dssh.team-ai.v1"));
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

#[cfg(test)]
fn restore_at(path: &Path, bundle: Bundle) -> Result<RestoreResult, SyncError> {
    restore_at_with(path, bundle, || Ok(()))
}

pub(crate) fn restore_at_with(path: &Path, mut bundle: Bundle, before_commit: impl FnOnce() -> Result<(), SyncError>) -> Result<RestoreResult, SyncError> {
    strip_retired_ai(&mut bundle.ui_state);
    bundle.ai_keys.clear();
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
        if !bundle.legacy {
            remap_team_connections(&mut bundle.ui_state, &id_map)?;
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
        before_commit()?;
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
