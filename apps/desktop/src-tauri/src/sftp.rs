//! SFTP 文件管理（russh-sftp）。每个命令按需创建并关闭一个 SFTP 子会话。

use std::path::{Path, PathBuf};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::State;
use tokio::io::{AsyncWriteExt, copy};

use crate::ssh::SshState;

/// SFTP 目录项（字段名与前端 camelCase 对齐）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub mtime: Option<u32>,
    pub permissions: Option<u32>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("会话不存在: {0}（可能已断开）")]
    NotFound(String),
    #[error("SFTP 错误: {0}")]
    Sftp(String),
    #[error("文件操作失败: {0}")]
    Io(String),
}

impl serde::Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<russh::Error> for Error {
    fn from(error: russh::Error) -> Self {
        Self::Sftp(error.to_string())
    }
}

impl From<russh_sftp::client::error::Error> for Error {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        Self::Sftp(error.to_string())
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

async fn open_sftp(state: &SshState, session_id: &str) -> Result<SftpSession, Error> {
    let handle = state
        .get_handle(session_id)
        .await
        .ok_or_else(|| Error::NotFound(session_id.to_owned()))?;
    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    Ok(SftpSession::new(channel.into_stream()).await?)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    let mut directory = sftp.read_dir(path).await?;
    let mut entries = Vec::new();

    for entry in &mut directory {
        let metadata = entry.metadata();
        entries.push(FileEntry {
            name: entry.file_name(),
            path: entry.path(),
            is_dir: metadata.is_dir(),
            size: metadata.size,
            mtime: metadata.mtime,
            permissions: metadata.permissions,
        });
    }

    sftp.close().await?;
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn downloads_dir() -> Result<PathBuf, Error> {
    let home = std::env::home_dir()
        .ok_or_else(|| Error::Io("无法确定用户主目录".to_owned()))?;
    Ok(home.join("Downloads").join("dssh"))
}

fn remote_file_name(remote_path: &str) -> Result<String, Error> {
    Path::new(remote_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty() && *name != "." && *name != "..")
        .map(str::to_owned)
        .ok_or_else(|| Error::Io("远程路径不是有效文件路径".to_owned()))
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, SshState>,
    session_id: String,
    remote_path: String,
) -> Result<String, Error> {
    let destination_dir = downloads_dir()?;
    tokio::fs::create_dir_all(&destination_dir).await?;
    let destination = destination_dir.join(remote_file_name(&remote_path)?);

    let sftp = open_sftp(&state, &session_id).await?;
    let mut remote = sftp.open(remote_path).await?;
    let mut local = tokio::fs::File::create(&destination).await?;
    copy(&mut remote, &mut local).await?;
    local.flush().await?;
    remote.close().await?;
    sftp.close().await?;

    Ok(destination.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, SshState>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), Error> {
    let mut local = tokio::fs::File::open(local_path).await?;
    let sftp = open_sftp(&state, &session_id).await?;
    let mut remote = sftp.create(remote_path).await?;
    copy(&mut local, &mut remote).await?;
    remote.shutdown().await?;
    sftp.close().await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<(), Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    sftp.create_dir(path).await?;
    sftp.close().await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_delete(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    if is_dir {
        sftp.remove_dir(path).await?;
    } else {
        sftp.remove_file(path).await?;
    }
    sftp.close().await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SshState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    sftp.rename(old_path, new_path).await?;
    sftp.close().await?;
    Ok(())
}
