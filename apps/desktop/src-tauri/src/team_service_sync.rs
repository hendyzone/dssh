//! Native-only encrypted backup integration and safe project discovery.
use super::*;
use crate::sync::{
    bundle::{Bundle, RestoreResult},
    SyncError,
};
use rest::{response_error, response_json, WriteError};
use serde::{Deserialize, Serialize};

// Deliberately not Debug: this structure must only be serialized inside encryption.
#[derive(Clone, Serialize, Deserialize)]
pub struct Backup {
    pub endpoint: String,
    pub projects: Vec<String>,
    pub token: String,
}
#[derive(Serialize)]
pub struct Projects {
    pub projects: Vec<String>,
}
fn sync_error() -> SyncError {
    SyncError::Other("无法恢复团队服务配置或凭据".into())
}

impl TeamService {
    pub(crate) async fn backup(&self) -> Result<Option<Backup>, String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::ExportBackup(tx))
            .await
            .map_err(|_| "Team service stopped")?;
        rx.await.map_err(|_| "Team service stopped")?
    }
    pub(crate) async fn restore_sync(
        &self,
        path: PathBuf,
        bundle: Bundle,
    ) -> Result<RestoreResult, SyncError> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::RestoreBundle(path, bundle, tx))
            .await
            .map_err(|_| sync_error())?;
        rx.await.map_err(|_| sync_error())?
    }
    pub async fn projects(
        &self,
        url: Option<String>,
        token: Option<String>,
    ) -> Result<Projects, WriteError> {
        let (endpoint, token) = match (url, token) {
            (None, None) => {
                let context = self.native_context("").await?;
                (context.endpoint, context.token)
            }
            (Some(url), Some(token)) if !token.trim().is_empty() => (
                validate_url(&url).map_err(|_| WriteError::new("invalid_configuration", 0))?,
                token,
            ),
            _ => return Err(WriteError::new("invalid_configuration", 0)),
        };
        let mut url = reqwest::Url::parse(&endpoint)
            .map_err(|_| WriteError::new("invalid_configuration", 0))?;
        let scheme = if url.scheme() == "wss" {
            "https"
        } else {
            "http"
        };
        url.set_scheme(scheme)
            .map_err(|_| WriteError::new("invalid_configuration", 0))?;
        let path = url
            .path()
            .strip_suffix("/team/ws")
            .ok_or_else(|| WriteError::new("invalid_configuration", 0))?
            .to_owned();
        url.set_path(&(path + "/projects"));
        let mut authorization = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| WriteError::new("credential_unavailable", 0))?;
        authorization.set_sensitive(true);
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| WriteError::new("transport_error", 0))?;
        let response = client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, authorization)
            .send()
            .await
            .map_err(|_| WriteError::new("transport_error", 0))?;
        let status = response.status().as_u16();
        let value = response_json(response).await?;
        if status != 200 {
            return Err(response_error(status, &value));
        }
        let rows = value["projects"]
            .as_array()
            .filter(|rows| rows.len() <= 10000)
            .ok_or_else(|| WriteError::new("invalid_response", 0))?;
        let mut projects = BTreeSet::new();
        for row in rows {
            let project = row["project"]
                .as_str()
                .filter(|p| project_valid(p))
                .ok_or_else(|| WriteError::new("invalid_response", 0))?;
            projects.insert(project.to_owned());
        }
        Ok(Projects {
            projects: projects.into_iter().collect(),
        })
    }
}
impl Actor {
    pub(super) fn export_backup(&self) -> Result<Option<Backup>, String> {
        self.endpoint
            .as_ref()
            .map(|endpoint| {
                Ok(Backup {
                    endpoint: endpoint.clone(),
                    projects: self.projects.iter().cloned().collect(),
                    token: self.vault.load(endpoint)?,
                })
            })
            .transpose()
    }
    pub(super) fn restore_bundle(
        &mut self,
        path: &Path,
        bundle: Bundle,
    ) -> Result<RestoreResult, SyncError> {
        let backup = bundle.team_service.clone();
        let Some(mut backup) = backup else {
            return crate::sync::bundle::restore_at_with(path, bundle, || Ok(()));
        };
        backup.endpoint = validate_url(&backup.endpoint).map_err(|_| sync_error())?;
        if backup.projects.len() > 64
            || backup.projects.iter().any(|p| !project_valid(p))
            || backup.token.trim().is_empty()
            || HeaderValue::from_str(&format!("Bearer {}", backup.token)).is_err()
        {
            return Err(sync_error());
        }
        let config_path = self.directory.join("config.json");
        let old_config = if config_path.exists() {
            Some(fs::read(&config_path).map_err(|_| sync_error())?)
        } else {
            None
        };
        let cache_path = self.directory.join("snapshots.json");
        let old_cache = if cache_path.exists() {
            Some(fs::read(&cache_path).map_err(|_| sync_error())?)
        } else {
            None
        };
        let old_token = self
            .vault
            .existing(&backup.endpoint)
            .map_err(|_| sync_error())?;
        let mut touched = false;
        let result = crate::sync::bundle::restore_at_with(path, bundle, || {
            self.vault
                .store(&backup.endpoint, &backup.token)
                .map_err(|_| sync_error())?;
            touched = true;
            atomic_json(
                &config_path,
                &json!({"endpoint":backup.endpoint,"projects":backup.projects}),
            )
            .map_err(|_| sync_error())?;
            atomic_json(
                &cache_path,
                &json!({"endpoint":backup.endpoint,"projects":{}}),
            )
            .map_err(|_| sync_error())
        });
        if result.is_err() {
            if touched {
                let key_result = match old_token {
                    Some(token) => self.vault.store(&backup.endpoint, &token),
                    None => self.vault.remove(&backup.endpoint),
                };
                let restore_file = |path: &Path, old: Option<Vec<u8>>| -> Result<(), String> {
                    match old {
                        Some(raw) if fs::read(path).ok().as_ref() == Some(&raw) => Ok(()),
                        Some(raw) => atomic_bytes(path, &raw),
                        None => match fs::remove_file(path) {
                            Ok(()) => Ok(()),
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                            Err(_) => Err("Cannot restore configuration".into()),
                        },
                    }
                };
                let file_result = restore_file(&config_path, old_config);
                let cache_result = restore_file(&cache_path, old_cache);
                if key_result.is_err() || file_result.is_err() || cache_result.is_err() {
                    return Err(SyncError::Other(
                        "恢复失败；本机团队服务配置回滚失败，请检查系统凭据库与磁盘".into(),
                    ));
                }
            }
            return result;
        }
        self.endpoint = Some(backup.endpoint);
        self.projects = backup.projects.into_iter().collect();
        self.generation = self.generation.wrapping_add(1);
        self.configured = true;
        self.halted = false;
        self.snapshots.clear();
        self.lseq.clear();
        self.sink.emit(
            "team://configuration",
            json!({"url":self.endpoint,"projects":self.projects}),
        );
        self.status("offline");
        result
    }
}
#[tauri::command]
pub async fn team_service_projects(
    state: State<'_, TeamService>,
    url: Option<String>,
    token: Option<String>,
) -> Result<Projects, WriteError> {
    state.projects(url, token).await
}
