//! GitHub 加密同步。
//!
//! 同步文件只包含 ServerRecord 列表（包括转发规则），不包含服务器密码或私钥
//! passphrase；这些秘密始终留在每台机器的系统 keyring 中，不会上传。

use std::fs;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rand::{rngs::OsRng, RngCore};
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::servers::{self, ServerRecord};

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
    Ok(format!("{GITHUB_API}/repos/{repository}/contents/{SYNC_FILE}"))
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

fn encrypt_servers(servers: &[ServerRecord], password: &str) -> Result<Vec<u8>, SyncError> {
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
    let plain = serde_json::to_vec(servers)
        .map_err(|error| SyncError::Other(format!("读取服务器配置失败: {error}")))?;
    let data = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_ref())
        .map_err(|_| SyncError::Other("加密服务器配置失败".to_string()))?;
    let envelope = EncryptedSyncFile {
        v: 1,
        kdf: KdfInfo {
            salt: BASE64.encode(salt),
        },
        nonce: BASE64.encode(nonce_bytes),
        data: BASE64.encode(data),
    };
    serde_json::to_vec(&envelope)
        .map_err(|error| SyncError::Other(format!("生成同步文件失败: {error}")))
}

fn decrypt_servers(raw: &[u8], password: &str) -> Result<Vec<ServerRecord>, SyncError> {
    let envelope: EncryptedSyncFile = serde_json::from_slice(raw)
        .map_err(|_| SyncError::Other("同步文件损坏或格式不受支持".to_string()))?;
    if envelope.v != 1 {
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
    if salt.is_empty() || nonce.len() != 12 {
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
    serde_json::from_slice(&plain)
        .map_err(|_| SyncError::Other("同步密码正确但文件损坏（服务器列表无效）".to_string()))
}

/// 测试 PAT 和仓库可达性；不会读取或修改同步文件。
#[tauri::command]
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
    Ok(SyncTestResult {
        repository,
        exists: true,
        private: metadata.private,
        full_name: metadata.full_name.unwrap_or_else(|| format!("{owner}/{name}")),
    })
}

/// 上传本机服务器列表。服务器密码和私钥 passphrase 不在 ServerRecord 中，因此不会同步。
#[tauri::command]
pub async fn sync_upload(
    app: AppHandle,
    pat: Option<String>,
    repository: String,
    password: Option<String>,
) -> Result<String, SyncError> {
    let pat = resolve_secret(pat, PAT_ACCOUNT, "GitHub PAT")?;
    let password = resolve_secret(password, PASSWORD_ACCOUNT, "同步密码")?;
    let client = github_client()?;
    let local = servers::read_all(&app).map_err(|error| SyncError::Other(error.to_string()))?;
    let encrypted = encrypt_servers(&local, &password)?;
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
    Ok(format!("已上传 {} 个服务器配置", local.len()))
}

/// 下载并整体替换本机服务器列表；替换前保留 servers.json.bak（last-write-wins，不合并）。
#[tauri::command]
pub async fn sync_download(
    app: AppHandle,
    pat: Option<String>,
    repository: String,
    password: Option<String>,
) -> Result<String, SyncError> {
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
    let servers = decrypt_servers(&encrypted, &password)?;

    let path = servers::servers_file(&app).map_err(|error| SyncError::Other(error.to_string()))?;
    if path.exists() {
        let backup = path.with_file_name("servers.json.bak");
        fs::copy(&path, backup).map_err(|error| {
            SyncError::Other(format!("下载前备份本地 servers.json 失败: {error}"))
        })?;
    }
    servers::write_all(&app, &servers).map_err(|error| SyncError::Other(error.to_string()))?;
    Ok(format!("已下载并替换 {} 个服务器配置", servers.len()))
}
