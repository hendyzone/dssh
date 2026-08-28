//! SFTP 文件管理（russh-sftp）。每个命令按需创建并关闭一个 SFTP 子会话。

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::OnceLock,
};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

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
    #[error("传输已取消")]
    Canceled,
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

/// 上传取消标志由命令共享，保证面板关闭后传输仍可被取消。
static CANCELED_TRANSFERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn canceled_transfers() -> &'static Mutex<HashSet<String>> {
    CANCELED_TRANSFERS.get_or_init(|| Mutex::new(HashSet::new()))
}

async fn take_cancel_flag(transfer_id: &str) -> bool {
    canceled_transfers().lock().await.remove(transfer_id)
}

async fn clear_cancel_flag(transfer_id: &str) {
    canceled_transfers().lock().await.remove(transfer_id);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TransferProgress {
    transfer_id: String,
    direction: &'static str,
    file_name: String,
    transferred_bytes: u64,
    total_bytes: u64,
    done: bool,
    error: Option<String>,
}

fn progress_event_name(session_id: &str) -> String {
    format!("sftp://{session_id}/upload-progress")
}

fn emit_progress(
    app: &AppHandle,
    session_id: &str,
    transfer_id: &str,
    direction: &'static str,
    file_name: &str,
    transferred_bytes: u64,
    total_bytes: u64,
    done: bool,
    error: Option<String>,
) {
    let payload = TransferProgress {
        transfer_id: transfer_id.to_owned(),
        direction,
        file_name: file_name.to_owned(),
        transferred_bytes,
        total_bytes,
        done,
        error,
    };
    // 前端面板可能暂时未打开，事件发送失败不应影响实际传输结果。
    let _ = app.emit(&progress_event_name(session_id), payload);
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
    let home = std::env::home_dir().ok_or_else(|| Error::Io("无法确定用户主目录".to_owned()))?;
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
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    remote_path: String,
    transfer_id: String,
) -> Result<String, Error> {
    let file_name = match remote_file_name(&remote_path) {
        Ok(name) => name,
        Err(error) => {
            emit_progress(
                &app,
                &session_id,
                &transfer_id,
                "download",
                "下载文件",
                0,
                0,
                true,
                Some(error.to_string()),
            );
            return Err(error);
        }
    };
    let mut transferred_bytes = 0_u64;
    let mut total_bytes = 0_u64;
    let result = async {
        let destination_dir = downloads_dir()?;
        tokio::fs::create_dir_all(&destination_dir).await?;
        let destination = destination_dir.join(&file_name);
        if take_cancel_flag(&transfer_id).await {
            return Err(Error::Canceled);
        }
        let sftp = open_sftp(&state, &session_id).await?;
        let mut remote = sftp.open(remote_path).await?;
        total_bytes = remote.metadata().await?.size.unwrap_or(0);
        let mut local = tokio::fs::File::create(&destination).await?;
        let mut buffer = vec![0_u8; 32 * 1024];
        emit_progress(
            &app,
            &session_id,
            &transfer_id,
            "download",
            &file_name,
            0,
            total_bytes,
            false,
            None,
        );
        loop {
            if take_cancel_flag(&transfer_id).await {
                let _ = remote.close().await;
                let _ = sftp.close().await;
                let _ = tokio::fs::remove_file(&destination).await;
                return Err(Error::Canceled);
            }
            let read = remote.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            local.write_all(&buffer[..read]).await?;
            transferred_bytes += read as u64;
            emit_progress(
                &app,
                &session_id,
                &transfer_id,
                "download",
                &file_name,
                transferred_bytes,
                total_bytes,
                false,
                None,
            );
        }
        local.flush().await?;
        remote.close().await?;
        sftp.close().await?;
        Ok::<String, Error>(destination.to_string_lossy().into_owned())
    }
    .await;

    match &result {
        Ok(_) => emit_progress(
            &app,
            &session_id,
            &transfer_id,
            "download",
            &file_name,
            transferred_bytes,
            total_bytes,
            true,
            None,
        ),
        Err(error) => emit_progress(
            &app,
            &session_id,
            &transfer_id,
            "download",
            &file_name,
            transferred_bytes,
            total_bytes,
            true,
            Some(error.to_string()),
        ),
    }
    clear_cancel_flag(&transfer_id).await;
    result
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: String,
) -> Result<(), Error> {
    let file_name = Path::new(&local_path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&local_path)
        .to_owned();
    let mut transferred_bytes = 0_u64;
    let mut total_bytes = 0_u64;
    let result = async {
        if take_cancel_flag(&transfer_id).await {
            return Err(Error::Canceled);
        }
        let mut local = tokio::fs::File::open(&local_path).await?;
        total_bytes = local.metadata().await?.len();
        let sftp = open_sftp(&state, &session_id).await?;
        let mut remote = sftp.create(remote_path.clone()).await?;
        let mut buffer = vec![0_u8; 32 * 1024];
        emit_progress(
            &app,
            &session_id,
            &transfer_id,
            "upload",
            &file_name,
            0,
            total_bytes,
            false,
            None,
        );
        loop {
            if take_cancel_flag(&transfer_id).await {
                let _ = remote.shutdown().await;
                let _ = remote.close().await;
                let _ = sftp.remove_file(remote_path.clone()).await;
                let _ = sftp.close().await;
                return Err(Error::Canceled);
            }
            let read = local.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            remote.write_all(&buffer[..read]).await?;
            transferred_bytes += read as u64;
            emit_progress(
                &app,
                &session_id,
                &transfer_id,
                "upload",
                &file_name,
                transferred_bytes,
                total_bytes,
                false,
                None,
            );
        }
        remote.shutdown().await?;
        sftp.close().await?;
        Ok::<(), Error>(())
    }
    .await;

    match &result {
        Ok(_) => emit_progress(
            &app,
            &session_id,
            &transfer_id,
            "upload",
            &file_name,
            transferred_bytes,
            total_bytes,
            true,
            None,
        ),
        Err(error) => emit_progress(
            &app,
            &session_id,
            &transfer_id,
            "upload",
            &file_name,
            transferred_bytes,
            total_bytes,
            true,
            Some(error.to_string()),
        ),
    }
    clear_cancel_flag(&transfer_id).await;
    result
}

#[tauri::command]
pub async fn cancel_upload(transfer_id: String) -> Result<(), Error> {
    canceled_transfers().lock().await.insert(transfer_id);
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
