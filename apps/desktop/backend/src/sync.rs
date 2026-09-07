//! GitHub 加密同步。
//!
//! 完整配置、系统凭据和私钥在本机经 Argon2 + AES-GCM 加密后上传。
//! 凭据和私钥仅在 Rust 后端处理，不通过前端 IPC 返回。

#[path = "sync_bundle.rs"]
pub(crate) mod bundle;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use crate::runtime::AppHandle;

use crate::servers::ServerRecord;

const SYNC_SERVICE: &str = "dssh.sync";
const PAT_ACCOUNT: &str = "github_pat";
const PASSWORD_ACCOUNT: &str = "sync_password";
const SYNC_FILE: &str = "dssh-sync.json.enc";
const GITHUB_API: &str = "https://api.github.com";

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for SyncError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTestResult {
    pub repository: String,
    pub exists: bool,
    pub private: bool,
    pub full_name: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct EncryptedSyncFile {
    v: u8,
    kdf: KdfInfo,
    nonce: String,
    data: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct KdfInfo {
    salt: String,
}

#[derive(Debug, Deserialize)]
struct GitHubRepository {
    private: bool,
    full_name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitHubContent {
    content: Option<String>,
    sha: Option<String>,
}

#[derive(Debug, Serialize)]
struct GitHubPutBody<'a> {
    message: &'a str,
    content: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sha: Option<&'a str>,
}

fn keyring_value(account: &str) -> Option<String> {
    keyring::Entry::new(SYNC_SERVICE, account)
        .ok()?
        .get_password()
        .ok()
}

fn save_keyring_value(account: &str, value: &str) -> Result<(), SyncError> {
    keyring::Entry::new(SYNC_SERVICE, account)
        .and_then(|entry| entry.set_password(value))
        .map_err(|error| SyncError::Other(format!("系统 keyring 写入失败: {error}")))
}

fn resolve_secret(
    provided: Option<String>,
    account: &str,
    label: &str,
) -> Result<String, SyncError> {
    // 空输入代表“已保存（留空保持不变）”，不会覆盖 keyring 中已有值。
    if let Some(value) = provided.filter(|value| !value.is_empty()) {
        save_keyring_value(account, &value)?;
        return Ok(value);
    }
    keyring_value(account).ok_or_else(|| SyncError::Other(format!("请先提供{label}")))
}

fn validate_repository(repository: &str) -> Result<(&str, &str), SyncError> {
    let mut parts = repository.split('/');
    let owner = parts.next().unwrap_or_default();
    let name = parts.next().unwrap_or_default();
    if owner.is_empty()
        || name.is_empty()
        || parts.next().is_some()
        || owner == "."
        || owner == ".."
        || name == "."
        || name == ".."
        || owner.chars().any(char::is_whitespace)
        || name.chars().any(char::is_whitespace)
    {
        return Err(SyncError::Other("仓库格式应为 owner/name".to_string()));
    }
    Ok((owner, name))
}

fn github_client() -> Result<Client, SyncError> {
    Client::builder()
        .user_agent("dssh-sync")
        .build()
        .map_err(|error| SyncError::Other(format!("创建 HTTPS 客户端失败: {error}")))
}

fn contents_url(repository: &str) -> Result<String, SyncError> {
    validate_repository(repository)?;
    Ok(format!(
        "{GITHUB_API}/repos/{repository}/contents/{SYNC_FILE}"
    ))
}

async fn report_failure(response: Response) -> SyncError {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    let reason = match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => "GitHub PAT 无效或权限不足".to_string(),
        StatusCode::NOT_FOUND => "GitHub 仓库不存在，或 PAT 无权访问".to_string(),
        _ => {
            let detail = if body.is_empty() {
                String::new()
            } else {
                format!(": {body}")
            };
            format!("GitHub API 请求失败（{status}）{detail}")
        }
    };
    SyncError::Other(reason)
}

async fn get_contents(
    client: &Client,
    repository: &str,
    pat: &str,
) -> Result<Option<GitHubContent>, SyncError> {
    let url = contents_url(repository)?;
    let response = client
        .get(url)
        .bearer_auth(pat)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| SyncError::Other(format!("连接 GitHub 失败: {error}")))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(report_failure(response).await);
    }
    response
        .json::<GitHubContent>()
        .await
        .map(Some)
        .map_err(|error| SyncError::Other(format!("GitHub 响应格式异常: {error}")))
}

fn encrypt_bundle(payload: &bundle::Bundle, password: &str) -> Result<Vec<u8>, SyncError> {
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|error| SyncError::Other(format!("生成加密密钥失败: {error}")))?;

    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| SyncError::Other(format!("初始化加密失败: {error}")))?;
    let plain = serde_json::to_vec(payload)
        .map_err(|error| SyncError::Other(format!("读取服务器配置失败: {error}")))?;
    let data = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_ref())
        .map_err(|_| SyncError::Other("加密服务器配置失败".to_string()))?;
    let envelope = EncryptedSyncFile {
        v: 2,
        kdf: KdfInfo {
            salt: BASE64.encode(salt),
        },
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(data),
    };
    serde_json::to_vec(&envelope)
        .map_err(|error| SyncError::Other(format!("生成同步文件失败: {error}")))
}

fn decrypt_bundle(raw: &[u8], password: &str) -> Result<bundle::Bundle, SyncError> {
    if raw.len() > 900 * 1024 {
        return Err(SyncError::Other("同步文件超过 900 KB 限制".into()));
    }
    let envelope: EncryptedSyncFile = serde_json::from_slice(raw)
        .map_err(|_| SyncError::Other("同步文件损坏或格式不受支持".to_string()))?;
    if envelope.v != 1 && envelope.v != 2 {
        return Err(SyncError::Other("同步文件版本不受支持".to_string()));
    }
    let salt = BASE64
        .decode(envelope.kdf.salt)
        .map_err(|_| SyncError::Other("同步文件损坏（salt 无效）".to_string()))?;
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|_| SyncError::Other("同步文件损坏（nonce 无效）".to_string()))?;
    let data = BASE64
        .decode(envelope.data)
        .map_err(|_| SyncError::Other("同步文件损坏（密文无效）".to_string()))?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err(SyncError::Other("同步文件损坏（加密参数无效）".to_string()));
    }
    let mut key = [0_u8; 32];
    Argon2::default()
        .hash_password_into(password.as_bytes(), &salt, &mut key)
        .map_err(|error| SyncError::Other(format!("生成解密密钥失败: {error}")))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|error| SyncError::Other(format!("初始化解密失败: {error}")))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce), data.as_ref())
        .map_err(|_| SyncError::Other("同步密码错误或文件损坏（AES-GCM 认证失败）".to_string()))?;
    if envelope.v == 1 {
        let records: Vec<ServerRecord> = serde_json::from_slice(&plain)
            .map_err(|_| SyncError::Other("旧版备份格式无效".into()))?;
        Ok(bundle::Bundle {
            entries: records
                .into_iter()
                .map(|record| bundle::Entry {
                    record,
                    password: None,
                    passphrase: None,
                    private_key: None,
                })
                .collect(),
            ui_state: Default::default(),
            legacy: true,
        })
    } else {
        serde_json::from_slice(&plain).map_err(|_| SyncError::Other("完整备份格式无效".into()))
    }
}

/// 测试 PAT 和仓库可达性；不会读取或修改同步文件。
pub async fn sync_test(
    pat: Option<String>,
    repository: String,
) -> Result<SyncTestResult, SyncError> {
    let pat = resolve_secret(pat, PAT_ACCOUNT, "GitHub PAT")?;
    let (owner, name) = validate_repository(&repository)?;
    let client = github_client()?;
    let response = client
        .get(format!("{GITHUB_API}/repos/{owner}/{name}"))
        .bearer_auth(&pat)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| SyncError::Other(format!("连接 GitHub 失败: {error}")))?;
    if !response.status().is_success() {
        return Err(report_failure(response).await);
    }
    let metadata = response
        .json::<GitHubRepository>()
        .await
        .map_err(|error| SyncError::Other(format!("GitHub 仓库响应格式异常: {error}")))?;
    // 先把借用了 repository 的 full_name 算出来，才能在结构体里 move repository。
    let full_name = metadata
        .full_name
        .unwrap_or_else(|| format!("{owner}/{name}"));
    Ok(SyncTestResult {
        repository,
        exists: true,
        private: metadata.private,
        full_name,
    })
}

/// 上传加密的完整备份。
pub async fn sync_upload(
    app: AppHandle,
    pat: Option<String>,
    repository: String,
    password: Option<String>,
    ui_state: Option<bundle::UiState>,
) -> Result<String, SyncError> {
    let pat = resolve_secret(pat, PAT_ACCOUNT, "GitHub PAT")?;
    let password = resolve_secret(password, PASSWORD_ACCOUNT, "同步密码")?;
    let client = github_client()?;
    let local = bundle::collect(&app, ui_state.unwrap_or_default())?;
    let encrypted = encrypt_bundle(&local, &password)?;
    if encrypted.len() > 900 * 1024 {
        return Err(SyncError::Other(
            "完整备份超过 900 KB，请检查私钥文件和界面配置大小".into(),
        ));
    }
    let encoded = BASE64.encode(encrypted);
    let existing = get_contents(&client, &repository, &pat).await?;
    let sha = existing.as_ref().and_then(|content| content.sha.as_deref());
    let response = client
        .put(contents_url(&repository)?)
        .bearer_auth(&pat)
        .header("Accept", "application/vnd.github+json")
        .json(&GitHubPutBody {
            message: "同步 dssh 服务器配置",
            content: &encoded,
            sha,
        })
        .send()
        .await
        .map_err(|error| SyncError::Other(format!("连接 GitHub 失败: {error}")))?;
    if !response.status().is_success() {
        return Err(report_failure(response).await);
    }
    Ok(format!(
        "已加密上传 {} 个连接及凭据、私钥和界面配置",
        local.entries.len()
    ))
}

/// 下载并整体替换本机服务器列表；替换前保留 servers.json.bak（last-write-wins，不合并）。
pub async fn sync_download(
    app: AppHandle,
    pat: Option<String>,
    repository: String,
    password: Option<String>,
) -> Result<bundle::RestoreResult, SyncError> {
    let pat = resolve_secret(pat, PAT_ACCOUNT, "GitHub PAT")?;
    let password = resolve_secret(password, PASSWORD_ACCOUNT, "同步密码")?;
    let client = github_client()?;
    let content = get_contents(&client, &repository, &pat)
        .await?
        .ok_or_else(|| SyncError::Other("GitHub 中不存在 dssh-sync.json.enc".to_string()))?;
    let encoded = content
        .content
        .ok_or_else(|| SyncError::Other("GitHub 同步文件缺少内容".to_string()))?;
    let encoded = encoded.replace(['\n', '\r'], "");
    let encrypted = BASE64
        .decode(encoded)
        .map_err(|_| SyncError::Other("GitHub 同步文件不是有效的 Base64".to_string()))?;
    let payload = decrypt_bundle(&encrypted, &password)?;
    bundle::restore(&app, payload)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_backup_encrypts_secrets_and_round_trips() {
        let payload = bundle::sample_bundle();
        let encrypted = encrypt_bundle(&payload, "synthetic-sync-password").unwrap();
        let text = String::from_utf8(encrypted.clone()).unwrap();
        for secret in [
            "synthetic-ssh-password",
            "synthetic-key-passphrase",
            "synthetic-private-key-bytes",
            "example.invalid",
            "empty/child",
        ] {
            assert!(!text.contains(secret));
        }
        let restored = decrypt_bundle(&encrypted, "synthetic-sync-password").unwrap();
        assert_eq!(restored.entries[0].password, payload.entries[0].password);
        assert_eq!(
            restored.entries[0].private_key,
            payload.entries[0].private_key
        );
        assert_eq!(
            restored.entries[0].passphrase,
            payload.entries[0].passphrase
        );
        assert_eq!(restored.ui_state, payload.ui_state);
        assert_ne!(
            encrypted,
            encrypt_bundle(&payload, "synthetic-sync-password").unwrap()
        );
        assert!(decrypt_bundle(&encrypted, "wrong-password").is_err());
        let mut envelope: EncryptedSyncFile = serde_json::from_slice(&encrypted).unwrap();
        let mut data = BASE64.decode(&envelope.data).unwrap();
        data[0] ^= 1;
        envelope.data = BASE64.encode(data);
        assert!(decrypt_bundle(
            &serde_json::to_vec(&envelope).unwrap(),
            "synthetic-sync-password"
        )
        .is_err());
    }
    #[test]
    fn reads_original_v1_backups_without_inventing_credentials() {
        let salt = [1u8; 16];
        let nonce = [2u8; 12];
        let mut key = [0u8; 32];
        Argon2::default()
            .hash_password_into(b"legacy-password", &salt, &mut key)
            .unwrap();
        let records = vec![bundle::sample_bundle().entries.remove(0).record];
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let data = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                serde_json::to_vec(&records).unwrap().as_slice(),
            )
            .unwrap();
        let envelope = EncryptedSyncFile {
            v: 1,
            kdf: KdfInfo {
                salt: BASE64.encode(salt),
            },
            nonce: BASE64.encode(nonce),
            data: BASE64.encode(data),
        };
        let restored =
            decrypt_bundle(&serde_json::to_vec(&envelope).unwrap(), "legacy-password").unwrap();
        assert!(restored.legacy);
        assert!(restored.entries[0].password.is_none());
        assert!(restored.entries[0].private_key.is_none());
        assert!(restored.ui_state.is_empty());
    }
}
