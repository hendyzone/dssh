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
    let entries = list_directory(&sftp, path).await;
    sftp.close().await?;
    entries
}

async fn list_directory(sftp: &SftpSession, path: String) -> Result<Vec<FileEntry>, Error> {
    let mut directory = sftp.read_dir(path).await?;
    let mut entries = Vec::new();

    for entry in &mut directory {
        let metadata = entry.metadata();
        // READDIR describes the link itself. STAT follows relative and absolute
        // links on the server, while navigation keeps the original link path.
        // A broken/inaccessible link must not prevent listing its siblings.
        let target = if metadata.is_symlink() {
            sftp.metadata(entry.path()).await.ok()
        } else {
            None
        };
        let metadata = target.as_ref().unwrap_or(&metadata);
        entries.push(FileEntry {
            name: entry.file_name(),
            path: entry.path(),
            is_dir: metadata.is_dir(),
            size: metadata.size,
            mtime: metadata.mtime,
            permissions: metadata.permissions,
        });
    }

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
        let destination_dir = downloads_dir()?.join(random_name());
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

#[derive(Debug)]
struct UploadEntry {
    local: PathBuf,
    remote: String,
    is_dir: bool,
}

// Inspect directories before opening files (opening a directory fails with
// AccessDenied on Windows). Plan first so progress covers the complete tree.
async fn plan_upload(
    local: &Path,
    remote: &str,
    transfer_id: &str,
) -> Result<(Vec<UploadEntry>, u64), Error> {
    let mut pending = vec![(local.to_path_buf(), remote.to_owned())];
    let mut entries = Vec::new();
    let mut total = 0_u64;
    while let Some((local, remote)) = pending.pop() {
        if take_cancel_flag(transfer_id).await {
            return Err(Error::Canceled);
        }
        let metadata = tokio::fs::symlink_metadata(&local)
            .await
            .map_err(|error| Error::Io(format!("{}: {error}", local.display())))?;
        // Do not recurse through links, which can escape the dropped tree or loop.
        if metadata.file_type().is_symlink() {
            return Err(Error::Io(format!(
                "暂不支持上传符号链接：{}",
                local.display()
            )));
        }
        let is_dir = metadata.is_dir();
        if is_dir {
            let mut children = tokio::fs::read_dir(&local)
                .await
                .map_err(|error| Error::Io(format!("{}: {error}", local.display())))?;
            while let Some(child) = children.next_entry().await? {
                if take_cancel_flag(transfer_id).await {
                    return Err(Error::Canceled);
                }
                let name = child.file_name().into_string().map_err(|_| {
                    Error::Io(format!("文件名不是有效 UTF-8：{}", child.path().display()))
                })?;
                pending.push((
                    child.path(),
                    format!("{}/{name}", remote.trim_end_matches('/')),
                ));
            }
        } else if metadata.is_file() {
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| Error::Io("上传文件夹总大小超出限制".into()))?;
        } else {
            return Err(Error::Io(format!(
                "不支持上传此文件类型：{}",
                local.display()
            )));
        }
        // Parents precede children, including empty directories.
        entries.push(UploadEntry {
            local,
            remote,
            is_dir,
        });
    }
    Ok((entries, total))
}

async fn upload_entries(
    sftp: &SftpSession,
    entries: &[UploadEntry],
    transfer_id: &str,
    mut progress: impl FnMut(u64),
) -> Result<(), Error> {
    let mut transferred = 0;
    let mut buffer = vec![0_u8; 32 * 1024];
    for entry in entries {
        if take_cancel_flag(transfer_id).await {
            return Err(Error::Canceled);
        }
        if entry.is_dir {
            if let Err(error) = sftp.create_dir(&entry.remote).await {
                // Confirmed overwrites merge directories, never regular files.
                if !sftp
                    .metadata(&entry.remote)
                    .await
                    .map(|m| m.is_dir())
                    .unwrap_or(false)
                {
                    return Err(Error::Sftp(format!("创建目录 {}: {error}", entry.remote)));
                }
            }
            continue;
        }
        let mut local = tokio::fs::File::open(&entry.local)
            .await
            .map_err(|error| Error::Io(format!("{}: {error}", entry.local.display())))?;
        let mut remote = sftp.create(&entry.remote).await?;
        let result = async {
            loop {
                if take_cancel_flag(transfer_id).await {
                    return Err(Error::Canceled);
                }
                let read = local.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                remote.write_all(&buffer[..read]).await?;
                transferred += read as u64;
                progress(transferred);
            }
            Ok::<(), Error>(())
        }
        .await;
        let closed = remote.close().await;
        if matches!(&result, Err(Error::Canceled)) {
            // Only remove the interrupted file; leave completed files and directories.
            let _ = sftp.remove_file(&entry.remote).await;
        }
        result?;
        closed?;
    }
    Ok(())
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
        let (entries, bytes) =
            plan_upload(Path::new(&local_path), &remote_path, &transfer_id).await?;
        total_bytes = bytes;
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
        let sftp = open_sftp(&state, &session_id).await?;
        let uploaded = upload_entries(&sftp, &entries, &transfer_id, |bytes| {
            transferred_bytes = bytes;
            emit_progress(
                &app,
                &session_id,
                &transfer_id,
                "upload",
                &file_name,
                bytes,
                total_bytes,
                false,
                None,
            );
        })
        .await;
        // Close the SFTP channel on failure/cancellation too.
        let closed = sftp.close().await;
        uploaded?;
        closed?;
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
) -> Result<(), Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    let result = remove_entry(&sftp, path).await;
    sftp.close().await?;
    result
}

async fn remove_entry(sftp: &SftpSession, path: String) -> Result<(), Error> {
    // Do not follow links here, even when the UI displays them as directories.
    let metadata = sftp.symlink_metadata(path.clone()).await?;
    if metadata.is_dir() {
        sftp.remove_dir(path).await?;
    } else {
        sftp.remove_file(path).await?;
    }
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

fn random_name() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|v| format!("{v:02x}")).collect()
}

#[tauri::command]
pub async fn sftp_home(state: State<'_, SshState>, session_id: String) -> Result<String, Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    let path = sftp.canonicalize(".").await?;
    sftp.close().await?;
    Ok(path)
}

#[tauri::command]
pub async fn sftp_clipboard_image(
    state: State<'_, SshState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<String, Error> {
    if data.len() > 20 * 1024 * 1024 || !data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Err(Error::Io("仅支持不超过 20 MB 的 PNG 截图".into()));
    }
    let sftp = open_sftp(&state, &session_id).await?;
    let home = sftp.canonicalize(".").await?;
    // A fresh private directory avoids shared temporary paths and symlink replacement.
    let dir = format!(
        "{}/.dssh-image-{}",
        home.trim_end_matches('/'),
        random_name()
    );
    sftp.create_dir(dir.clone()).await?;
    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.permissions = Some(0o700);
    sftp.set_metadata(dir.clone(), attrs).await?;
    let path = format!("{dir}/screenshot.png");
    if let Err(error) = write_remote_file(&sftp, &path, &data, true).await {
        let _ = sftp.remove_file(path.clone()).await;
        let _ = sftp.remove_dir(dir).await;
        let _ = sftp.close().await;
        return Err(Error::Io(format!("创建或写入截图失败: {error}")));
    }
    let mut attrs = russh_sftp::protocol::FileAttributes::default();
    attrs.permissions = Some(0o600);
    sftp.set_metadata(path.clone(), attrs).await?;
    sftp.close().await?;
    Ok(path)
}

async fn read_text(sftp: &SftpSession, path: &str) -> Result<String, Error> {
    let mut file = sftp.open(path).await?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await?;
    file.close().await?;
    if bytes.len() > 1024 * 1024 || bytes.contains(&0) {
        return Err(Error::Io(
            "在线编辑仅支持 1 MB 以内的 UTF-8 文本文件，请下载后打开".into(),
        ));
    }
    String::from_utf8(bytes).map_err(|_| Error::Io("文件不是 UTF-8 文本，请下载后打开".into()))
}
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<String, Error> {
    let sftp = open_sftp(&state, &session_id).await?;
    let result = read_text(&sftp, &path).await;
    let _ = sftp.close().await;
    result
}
#[tauri::command]
pub async fn sftp_save_text(
    state: State<'_, SshState>,
    session_id: String,
    path: String,
    original: String,
    content: String,
) -> Result<String, Error> {
    if content.len() > 1024 * 1024 {
        return Err(Error::Io("文本超过 1 MB".into()));
    }
    let sftp = open_sftp(&state, &session_id).await?;
    let result = async {
        if read_text(&sftp, &path).await? != original {
            return Err(Error::Io(
                "远程文件已变化，未覆盖。请复制当前修改，再重新打开文件合并。".into(),
            ));
        }
        let backup = format!("{path}.dssh-backup-{}", random_name());
        let mut backup_file = sftp
            .open_with_flags_and_attributes(
                backup.clone(),
                russh_sftp::protocol::OpenFlags::CREATE
                    | russh_sftp::protocol::OpenFlags::EXCLUDE
                    | russh_sftp::protocol::OpenFlags::WRITE,
                russh_sftp::protocol::FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await?;
        backup_file.write_all(original.as_bytes()).await?;
        backup_file.close().await?;
        write_remote_file(&sftp, &path, content.as_bytes(), false)
            .await
            .map_err(|_| Error::Io(format!("保存失败，原内容备份位于 {backup}")))?;
        Ok(backup)
    }
    .await;
    let _ = sftp.close().await;
    result
}
#[tauri::command]
pub async fn sftp_open_local(path: String, application: Option<String>) -> Result<(), Error> {
    let path = std::fs::canonicalize(path)?;
    let root = std::fs::canonicalize(downloads_dir()?)?;
    if !path.starts_with(root) || !path.is_file() {
        return Err(Error::Io("只能打开已下载的文件".into()));
    }
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if [
        "exe", "com", "bat", "cmd", "ps1", "msi", "lnk", "url", "scr", "vbs", "js", "hta",
    ]
    .contains(&ext.as_str())
    {
        return Err(Error::Io("可执行文件仅下载，不自动运行".into()));
    }
    let custom = application.filter(|v| !v.trim().is_empty());
    if let Some(ref app) = custom {
        if !Path::new(app).is_absolute() || !Path::new(app).is_file() {
            return Err(Error::Io("请选择有效的应用程序文件".into()));
        }
    }
    #[cfg(target_os = "windows")]
    let default_app = "explorer.exe";
    #[cfg(target_os = "macos")]
    let default_app = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let default_app = "xdg-open";
    let mut command = std::process::Command::new(custom.as_deref().unwrap_or(default_app));
    command.arg(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.spawn()?;
    Ok(())
}

// CREATE is required for new screenshots; existing text must be truncated to
// prevent stale trailing bytes when the saved content becomes shorter.
async fn write_remote_file(
    sftp: &SftpSession,
    path: &str,
    bytes: &[u8],
    new_file: bool,
) -> Result<(), Error> {
    use russh_sftp::protocol::{FileAttributes, OpenFlags};
    let flags = if new_file {
        OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
    } else {
        OpenFlags::WRITE | OpenFlags::TRUNCATE
    };
    let mut file = sftp
        .open_with_flags_and_attributes(
            path,
            flags,
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        )
        .await?;
    let result = file.write_all(bytes).await;
    let closed = file.close().await;
    result?;
    closed?;
    Ok(())
}

#[cfg(test)]
mod upload_tests {
    use super::*;

    pub(super) struct LocalTree(pub PathBuf);
    impl LocalTree {
        pub(super) fn new() -> Self {
            let path = std::env::temp_dir().join(format!("dssh-upload-test-{}", random_name()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for LocalTree {
        fn drop(&mut self) {
            let path = std::fs::canonicalize(&self.0).unwrap();
            let root = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            assert_eq!(path.parent(), Some(root.as_path()));
            assert!(path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("dssh-upload-test-"));
            std::fs::remove_dir_all(path).unwrap();
        }
    }

    #[tokio::test]
    async fn upload_plan_preserves_nested_unicode_and_empty_directories() {
        let tree = LocalTree::new();
        std::fs::create_dir_all(tree.0.join("子目录/空目录")).unwrap();
        std::fs::write(tree.0.join("卡背图.png"), b"png").unwrap();
        std::fs::write(tree.0.join("子目录/zero.txt"), b"").unwrap();
        std::fs::write(tree.0.join("子目录/data.txt"), b"hello").unwrap();
        let (entries, total) = plan_upload(&tree.0, "/remote/卡图", "plan-tree")
            .await
            .unwrap();
        assert_eq!(total, 8);
        assert_eq!(entries.len(), 6);
        assert!(entries[0].is_dir);
        for entry in entries.iter().skip(1) {
            let parent = entry.remote.rsplit_once('/').unwrap().0;
            let parent_index = entries
                .iter()
                .position(|e| e.remote == parent && e.is_dir)
                .unwrap();
            let index = entries
                .iter()
                .position(|e| e.remote == entry.remote)
                .unwrap();
            assert!(parent_index < index);
        }
        assert!(entries
            .iter()
            .any(|e| e.remote == "/remote/卡图/子目录/空目录" && e.is_dir));
        let (single, size) = plan_upload(&tree.0.join("卡背图.png"), "/single.png", "plan-file")
            .await
            .unwrap();
        assert_eq!(size, 3);
        assert_eq!(single.len(), 1);
        assert!(!single[0].is_dir);
    }

    #[tokio::test]
    async fn upload_plan_checks_cancellation_and_reports_missing_path() {
        let tree = LocalTree::new();
        cancel_upload("plan-cancel".into()).await.unwrap();
        assert!(matches!(
            plan_upload(&tree.0, "/remote", "plan-cancel").await,
            Err(Error::Canceled)
        ));
        let missing = tree.0.join("missing");
        let error = plan_upload(&missing, "/remote", "plan-missing")
            .await
            .unwrap_err();
        assert!(error.to_string().contains("missing"));
    }
}

#[cfg(all(test, windows))]
mod file_write_tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires extracted OpenSSH SFTP test runtime in tools/sftp-test"]
    async fn sftp_live_files_and_directory_links() {
        use std::process::Stdio;
        let mut process = tokio::process::Command::new("wsl")
            .args([
                "-d",
                "Ubuntu",
                "--",
                "/mnt/d/workspace/dssh/tools/sftp-test/runtime/usr/lib/openssh/sftp-server",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stream = tokio::io::join(
            process.stdout.take().unwrap(),
            process.stdin.take().unwrap(),
        );
        let sftp = SftpSession::new(stream).await.unwrap();
        let dir = format!("/tmp/dssh-sftp-test-{}", random_name());
        sftp.create_dir(dir.clone()).await.unwrap();
        // Exercise the exact backend helpers used by drag/drop against OpenSSH.
        let local = upload_tests::LocalTree::new();
        std::fs::create_dir_all(local.0.join("子目录/空目录")).unwrap();
        std::fs::write(local.0.join("卡背图.png"), b"png").unwrap();
        std::fs::write(local.0.join("子目录/zero.txt"), b"").unwrap();
        let remote_root = format!("{dir}/卡图");
        let (entries, total) = plan_upload(&local.0, &remote_root, "live-tree")
            .await
            .unwrap();
        let mut progress = Vec::new();
        upload_entries(&sftp, &entries, "live-tree", |bytes| progress.push(bytes))
            .await
            .unwrap();
        assert_eq!(progress.last(), Some(&total));
        assert_eq!(
            sftp.read(format!("{remote_root}/卡背图.png"))
                .await
                .unwrap(),
            b"png"
        );
        assert!(sftp
            .metadata(format!("{remote_root}/子目录/空目录"))
            .await
            .unwrap()
            .is_dir());
        assert!(sftp
            .read(format!("{remote_root}/子目录/zero.txt"))
            .await
            .unwrap()
            .is_empty());
        // Merge existing directories and truncate overwritten files.
        std::fs::write(local.0.join("卡背图.png"), b"x").unwrap();
        upload_entries(&sftp, &entries, "live-tree", |_| {})
            .await
            .unwrap();
        assert_eq!(
            sftp.read(format!("{remote_root}/卡背图.png"))
                .await
                .unwrap(),
            b"x"
        );
        // Cancel mid-file, checking both stopping and removal of the partial file.
        std::fs::write(local.0.join("large.bin"), vec![7; 100_000]).unwrap();
        let canceled_path = format!("{dir}/canceled.bin");
        let (single, _) = plan_upload(&local.0.join("large.bin"), &canceled_path, "live-cancel")
            .await
            .unwrap();
        let result = upload_entries(&sftp, &single, "live-cancel", |_| {
            canceled_transfers()
                .try_lock()
                .unwrap()
                .insert("live-cancel".into());
        })
        .await;
        assert!(matches!(result, Err(Error::Canceled)));
        assert!(sftp.metadata(&canceled_path).await.is_err());
        // An existing file cannot silently swallow a directory upload.
        let conflict = format!("{dir}/conflict");
        write_remote_file(&sftp, &conflict, b"keep", true)
            .await
            .unwrap();
        let (conflicting, _) = plan_upload(&local.0, &conflict, "live-conflict")
            .await
            .unwrap();
        assert!(upload_entries(&sftp, &conflicting, "live-conflict", |_| {})
            .await
            .is_err());
        assert_eq!(sftp.read(&conflict).await.unwrap(), b"keep");
        sftp.remove_file(conflict).await.unwrap();
        for name in ["卡背图.png", "子目录/zero.txt"] {
            sftp.remove_file(format!("{remote_root}/{name}"))
                .await
                .unwrap();
        }
        for name in ["子目录/空目录", "子目录"] {
            sftp.remove_dir(format!("{remote_root}/{name}"))
                .await
                .unwrap();
        }
        sftp.remove_dir(remote_root).await.unwrap();
        let target = format!("{dir}/target");
        sftp.create_dir(target.clone()).await.unwrap();
        write_remote_file(&sftp, &format!("{target}/child.txt"), b"child", true)
            .await
            .unwrap();
        for (name, destination) in [
            ("relative", "target"),
            ("absolute", target.as_str()),
            ("file-link", "target/child.txt"),
            ("broken", "missing"),
        ] {
            assert!(tokio::process::Command::new("wsl")
                .args([
                    "-d",
                    "Ubuntu",
                    "--",
                    "ln",
                    "-s",
                    destination,
                    &format!("{dir}/{name}")
                ])
                .status()
                .await
                .unwrap()
                .success());
        }
        let entries = list_directory(&sftp, dir.clone()).await.unwrap();
        for name in ["relative", "absolute"] {
            let entry = entries.iter().find(|entry| entry.name == name).unwrap();
            assert!(entry.is_dir);
            assert_eq!(entry.path, format!("{dir}/{name}"));
            let children = list_directory(&sftp, entry.path.clone()).await.unwrap();
            assert_eq!(children[0].name, "child.txt");
            remove_entry(&sftp, entry.path.clone()).await.unwrap();
            assert!(sftp.metadata(target.clone()).await.unwrap().is_dir());
        }
        for name in ["file-link", "broken"] {
            assert!(
                !entries
                    .iter()
                    .find(|entry| entry.name == name)
                    .unwrap()
                    .is_dir
            );
            remove_entry(&sftp, format!("{dir}/{name}")).await.unwrap();
        }
        assert_eq!(
            sftp.read(format!("{target}/child.txt")).await.unwrap(),
            b"child"
        );
        remove_entry(&sftp, format!("{target}/child.txt"))
            .await
            .unwrap();
        remove_entry(&sftp, target).await.unwrap();
        let path = format!("{dir}/screenshot.png");
        let png = [137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3];
        write_remote_file(&sftp, &path, &png, true).await.unwrap();
        assert_eq!(sftp.read(path.clone()).await.unwrap(), png);
        assert!(write_remote_file(&sftp, &path, b"collision", true)
            .await
            .is_err());
        assert_eq!(sftp.read(path.clone()).await.unwrap(), png);
        write_remote_file(&sftp, &path, b"short", false)
            .await
            .unwrap();
        assert_eq!(sftp.read(path.clone()).await.unwrap(), b"short");
        write_remote_file(&sftp, &path, b"", false).await.unwrap();
        assert!(sftp.read(path.clone()).await.unwrap().is_empty());
        sftp.remove_file(path.clone()).await.unwrap();
        assert!(write_remote_file(&sftp, &path, b"missing", false)
            .await
            .is_err());
        sftp.remove_dir(dir).await.unwrap();
        sftp.close().await.unwrap();
        let _ = process.kill().await;
    }
}
