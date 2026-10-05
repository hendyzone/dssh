//! 文件夹 / 多选递归下载。
//!
//! 一次下载（可含多个文件与目录）在前端显示为一个传输项：
//! 1. 统计：遍历远端树，只累计文件数与字节数（不保存文件清单）。
//! 2. 传输：再次遍历，生产者把文件任务送入有界队列，N 个 worker 并发下载。
//!
//! 所有 worker 共享同一条 SFTP 子通道（SFTP 请求自带 id，可在一条通道上并发），
//! 因此一个文件夹下载只占用一个 SSH channel，不会因并发而撞上服务端 MaxSessions。
//! 文件先写入同目录下的 `.<名称>.dssh-part-<随机>` 临时文件，完整后再改名，
//! 因此取消或失败时只需删除临时文件，已完成的文件与被覆盖前的原文件都不受影响。

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};

use russh_sftp::client::{fs::Metadata, SftpSession};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{mpsc, Mutex},
};

use crate::{
    sftp::{
        clear_cancel_flag, open_sftp, progress_event_name, random_name, take_cancel_flag, Error,
    },
    ssh::SshState,
};

/// 默认并发文件数。实测（每次请求往返约 16 ms 的链路，3000 个小文件）：4 并发 25.5 s、8 并发 13.2 s、16 并发 7.4 s；
/// 并发只是在同一 SFTP 通道上流水线化请求，不增加 SSH channel。
pub const DEFAULT_CONCURRENCY: usize = 8;
const MAX_CONCURRENCY: usize = 16;
/// 达到此大小的文件按区间并行读取（同一会话内多个句柄），提升高延迟链路吞吐。
const LARGE_FILE_BYTES: u64 = 16 * 1024 * 1024;
const LARGE_FILE_RANGES: u64 = 4;
const READ_BUFFER: usize = 256 * 1024;
/// 结果里最多保留的失败 / 跳过明细，计数不受限。
const MAX_ISSUES: usize = 1000;
/// 生产者与 worker 之间的队列长度，决定内存上限而非文件总数。
const QUEUE_DEPTH: usize = 256;

/// 本地目标已存在同名项时的处理方式（一次选择，作用于整批）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictPolicy {
    /// 合并目录，同名文件覆盖。
    Overwrite,
    /// 合并目录，同名文件跳过。
    Skip,
    /// 顶层另存为 `名称 (1)`。
    Rename,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeIssue {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TreeSnapshot {
    /// scanning | transferring | done
    pub phase: &'static str,
    pub discovered_files: u64,
    pub total_files: u64,
    pub completed_files: u64,
    pub downloaded_files: u64,
    pub skipped_existing: u64,
    pub current_file: String,
    pub failure_count: u64,
    pub skipped_count: u64,
    pub failures: Vec<TreeIssue>,
    pub skipped: Vec<TreeIssue>,
    pub local_roots: Vec<String>,
    pub canceled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSummary {
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    #[serde(flatten)]
    pub tree: TreeSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeProgressPayload {
    transfer_id: String,
    direction: &'static str,
    file_name: String,
    transferred_bytes: u64,
    total_bytes: u64,
    done: bool,
    error: Option<String>,
    tree: TreeSnapshot,
}

#[derive(Default)]
struct Issues {
    failures: Vec<TreeIssue>,
    failure_count: u64,
    skipped: Vec<TreeIssue>,
    skipped_count: u64,
}

/// 共享取消标志：前端 `cancel_upload` 写入全局集合，首个发现的任务转存为本地原子标志，
/// 让所有 worker 都能看到（全局集合是"取走即清除"语义）。
pub(crate) struct CancelToken {
    id: String,
    flag: AtomicBool,
}

impl CancelToken {
    pub(crate) fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            flag: AtomicBool::new(false),
        }
    }

    pub(crate) async fn is_canceled(&self) -> bool {
        if self.flag.load(Ordering::Relaxed) {
            return true;
        }
        if take_cancel_flag(&self.id).await {
            self.flag.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }

    fn already(&self) -> bool {
        self.flag.load(Ordering::Relaxed)
    }
}

/// 进度计数器，worker 写、定时器读。
pub(crate) struct TreeState {
    phase: AtomicU8,
    discovered_files: AtomicU64,
    total_files: AtomicU64,
    total_bytes: AtomicU64,
    completed_files: AtomicU64,
    downloaded_files: AtomicU64,
    skipped_existing: AtomicU64,
    transferred_bytes: AtomicU64,
    current: std::sync::Mutex<String>,
    issues: std::sync::Mutex<Issues>,
    local_roots: std::sync::Mutex<Vec<String>>,
    pub(crate) cancel: CancelToken,
}

impl TreeState {
    pub(crate) fn new(transfer_id: impl Into<String>) -> Self {
        Self {
            phase: AtomicU8::new(0),
            discovered_files: AtomicU64::new(0),
            total_files: AtomicU64::new(0),
            total_bytes: AtomicU64::new(0),
            completed_files: AtomicU64::new(0),
            downloaded_files: AtomicU64::new(0),
            skipped_existing: AtomicU64::new(0),
            transferred_bytes: AtomicU64::new(0),
            current: std::sync::Mutex::new(String::new()),
            issues: std::sync::Mutex::new(Issues::default()),
            local_roots: std::sync::Mutex::new(Vec::new()),
            cancel: CancelToken::new(transfer_id),
        }
    }

    fn fail(&self, path: impl Into<String>, reason: impl Into<String>) {
        let mut issues = self.issues.lock().unwrap();
        issues.failure_count += 1;
        if issues.failures.len() < MAX_ISSUES {
            issues.failures.push(TreeIssue {
                path: path.into(),
                reason: reason.into(),
            });
        }
    }

    fn skip(&self, path: impl Into<String>, reason: impl Into<String>) {
        let mut issues = self.issues.lock().unwrap();
        issues.skipped_count += 1;
        if issues.skipped.len() < MAX_ISSUES {
            issues.skipped.push(TreeIssue {
                path: path.into(),
                reason: reason.into(),
            });
        }
    }

    fn add_bytes(&self, bytes: u64) {
        self.transferred_bytes.fetch_add(bytes, Ordering::Relaxed);
    }

    fn sub_bytes(&self, bytes: u64) {
        let _ = self
            .transferred_bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
                Some(v.saturating_sub(bytes))
            });
    }

    /// 统计阶段之后文件可能新增，完成数超出总数时同步抬高总数。
    fn complete(&self) {
        let done = self.completed_files.fetch_add(1, Ordering::Relaxed) + 1;
        self.total_files.fetch_max(done, Ordering::Relaxed);
    }

    pub(crate) fn snapshot(&self, with_lists: bool) -> TreeSummary {
        let issues = self.issues.lock().unwrap();
        let transferred = self.transferred_bytes.load(Ordering::Relaxed);
        TreeSummary {
            transferred_bytes: transferred,
            total_bytes: self.total_bytes.load(Ordering::Relaxed).max(transferred),
            tree: TreeSnapshot {
                phase: match self.phase.load(Ordering::Relaxed) {
                    0 => "scanning",
                    1 => "transferring",
                    _ => "done",
                },
                discovered_files: self.discovered_files.load(Ordering::Relaxed),
                total_files: self.total_files.load(Ordering::Relaxed),
                completed_files: self.completed_files.load(Ordering::Relaxed),
                downloaded_files: self.downloaded_files.load(Ordering::Relaxed),
                skipped_existing: self.skipped_existing.load(Ordering::Relaxed),
                current_file: self.current.lock().unwrap().clone(),
                failure_count: issues.failure_count,
                skipped_count: issues.skipped_count,
                failures: if with_lists {
                    issues.failures.clone()
                } else {
                    Vec::new()
                },
                skipped: if with_lists {
                    issues.skipped.clone()
                } else {
                    Vec::new()
                },
                local_roots: self.local_roots.lock().unwrap().clone(),
                canceled: self.cancel.already(),
            },
        }
    }
}

/// 远端文件名能否作为本地路径的一段。`windows` 单独传入以便在任意平台测试。
pub(crate) fn local_component(name: &str, windows: bool) -> Result<&str, String> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err("文件名无效".into());
    }
    if windows {
        if name
            .chars()
            .any(|c| c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\'))
        {
            return Err("文件名含 Windows 不允许的字符".into());
        }
        if name.ends_with(['.', ' ']) {
            return Err("文件名以点或空格结尾，Windows 不支持".into());
        }
        let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
        let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && stem.as_bytes()[3].is_ascii_digit()
                && stem.as_bytes()[3] != b'0');
        if reserved {
            return Err("文件名是 Windows 保留设备名".into());
        }
    }
    Ok(name)
}

fn check_component(name: &str) -> Result<&str, String> {
    local_component(name, cfg!(windows))
}

pub(crate) fn join_remote(directory: &str, name: &str) -> String {
    if directory.ends_with('/') {
        format!("{directory}{name}")
    } else {
        format!("{directory}/{name}")
    }
}

pub(crate) fn remote_basename(path: &str) -> Option<&str> {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
}

/// `报告.txt` → `报告 (1).txt`；目录与点开头的名称整体加后缀。
pub(crate) fn numbered_name(name: &str, index: u32, is_dir: bool) -> String {
    if !is_dir {
        if let Some((stem, ext)) = name.rsplit_once('.') {
            if !stem.is_empty() {
                return format!("{stem} ({index}).{ext}");
            }
        }
    }
    format!("{name} ({index})")
}

fn exists_locally(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// 在 `dir` 下为 `name` 找一个本地与本批都未占用的名称。
pub(crate) fn unique_name(dir: &Path, name: &str, is_dir: bool, taken: &HashSet<String>) -> String {
    if !exists_locally(&dir.join(name)) && !taken.contains(name) {
        return name.to_owned();
    }
    (1..)
        .map(|index| numbered_name(name, index, is_dir))
        .find(|candidate| !exists_locally(&dir.join(candidate)) && !taken.contains(candidate))
        .unwrap()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalConflict {
    pub name: String,
    pub is_dir: bool,
    pub rename_to: String,
}

/// 前端在开始下载前查询哪些顶层名称会与本地冲突，以便一次性询问。
pub(crate) fn local_conflicts(dir: &Path, names: &[(String, bool)]) -> Vec<LocalConflict> {
    let mut taken = HashSet::new();
    let mut conflicts = Vec::new();
    for (name, is_dir) in names {
        if exists_locally(&dir.join(name)) {
            let rename_to = unique_name(dir, name, *is_dir, &taken);
            taken.insert(rename_to.clone());
            conflicts.push(LocalConflict {
                name: name.clone(),
                is_dir: std::fs::symlink_metadata(dir.join(name))
                    .map(|m| m.is_dir())
                    .unwrap_or(*is_dir),
                rename_to,
            });
        }
        taken.insert(name.clone());
    }
    conflicts
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictQuery {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
pub async fn sftp_local_conflicts(
    local_dir: String,
    entries: Vec<ConflictQuery>,
) -> Result<Vec<LocalConflict>, Error> {
    let dir = PathBuf::from(local_dir);
    if !dir.is_dir() {
        return Err(Error::Io("本地目标不是文件夹".into()));
    }
    let names: Vec<_> = entries.into_iter().map(|e| (e.name, e.is_dir)).collect();
    Ok(local_conflicts(&dir, &names))
}

/// 一个待下载的文件。
#[derive(Debug)]
struct FileJob {
    remote: String,
    local: PathBuf,
    display: String,
    size: u64,
    mtime: Option<u32>,
    permissions: Option<u32>,
}

#[derive(Debug)]
enum RootKind {
    Dir,
    File(Metadata),
}

#[derive(Debug)]
struct Root {
    remote: String,
    local: PathBuf,
    display: String,
    kind: RootKind,
}

/// 统计 / 传输两遍遍历对同一目录项的判定保持一致。
enum Classified {
    Dir,
    File(Metadata),
    /// 跳过（原因）
    Skip(String),
}

async fn classify(sftp: &SftpSession, path: &str, metadata: Metadata) -> Classified {
    if metadata.is_dir() {
        return Classified::Dir;
    }
    if metadata.file_type().is_file() {
        return Classified::File(metadata);
    }
    if metadata.is_symlink() {
        // 目录链接不跟随，避免循环与跳出所选目录；文件链接按目标内容下载。
        return match sftp.metadata(path).await {
            Ok(target) if target.is_dir() => Classified::Skip("目录符号链接（未跟随）".into()),
            Ok(target) if target.file_type().is_file() => Classified::File(target),
            Ok(_) => Classified::Skip("符号链接指向特殊文件".into()),
            Err(_) => Classified::Skip("符号链接目标不存在或不可访问".into()),
        };
    }
    Classified::Skip("特殊文件（设备、管道或套接字）".into())
}

async fn resolve_roots(
    sftp: &SftpSession,
    remote_paths: &[String],
    local_dir: &Path,
    policy: ConflictPolicy,
    state: &TreeState,
) -> Vec<Root> {
    let mut taken = HashSet::new();
    let mut roots = Vec::new();
    for remote in remote_paths {
        let Some(name) = remote_basename(remote) else {
            state.fail(remote.clone(), "不能下载根目录");
            continue;
        };
        if let Err(reason) = check_component(name) {
            state.fail(remote.clone(), reason);
            continue;
        }
        // 用户明确选中的顶层项：跟随其链接（列表里本来就按目标显示）。
        let metadata = match sftp.metadata(remote.clone()).await {
            Ok(metadata) => metadata,
            Err(error) => {
                state.fail(remote.clone(), error.to_string());
                continue;
            }
        };
        let kind = if metadata.is_dir() {
            RootKind::Dir
        } else if metadata.file_type().is_file() {
            RootKind::File(metadata)
        } else {
            state.skip(remote.clone(), "特殊文件（设备、管道或套接字）");
            continue;
        };
        let is_dir = matches!(kind, RootKind::Dir);
        let local_name = if policy == ConflictPolicy::Rename || taken.contains(name) {
            unique_name(local_dir, name, is_dir, &taken)
        } else {
            name.to_owned()
        };
        taken.insert(local_name.clone());
        roots.push(Root {
            remote: remote.trim_end_matches('/').to_owned(),
            local: local_dir.join(&local_name),
            display: local_name,
            kind,
        });
    }
    roots
}

/// 第一遍：只计数，内存只与待访问目录数有关。
async fn scan(sftp: &SftpSession, roots: &[Root], state: &TreeState) {
    let mut pending = Vec::new();
    for root in roots {
        match &root.kind {
            RootKind::File(metadata) => {
                state.discovered_files.fetch_add(1, Ordering::Relaxed);
                state.total_bytes.fetch_add(metadata.len(), Ordering::Relaxed);
            }
            RootKind::Dir => pending.push(root.remote.clone()),
        }
    }
    while let Some(dir) = pending.pop() {
        if state.cancel.is_canceled().await {
            return;
        }
        // 无法读取的目录在第二遍记为失败，这里静默。
        let Ok(entries) = sftp.read_dir(dir.clone()).await else {
            continue;
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join_remote(&dir, &name);
            match classify(sftp, &path, entry.metadata()).await {
                Classified::Dir => pending.push(path),
                Classified::File(metadata) => {
                    state.discovered_files.fetch_add(1, Ordering::Relaxed);
                    state.total_bytes.fetch_add(metadata.len(), Ordering::Relaxed);
                }
                Classified::Skip(_) => {}
            }
        }
    }
    let files = state.discovered_files.load(Ordering::Relaxed);
    state.total_files.fetch_max(files, Ordering::Relaxed);
}

/// 确保本地目录存在；已有同名普通目录时合并，已有文件或链接时失败（不跟随本地链接）。
async fn ensure_local_dir(path: &Path) -> Result<(), String> {
    match tokio::fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.is_dir() => Ok(()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("本地已存在同名符号链接，未合并".into())
        }
        Ok(_) => Err("本地已存在同名文件，无法创建目录".into()),
        Err(_) => tokio::fs::create_dir(path)
            .await
            .map_err(|error| format!("创建本地目录失败：{error}")),
    }
}

fn file_job(remote: String, local: PathBuf, display: String, metadata: &Metadata) -> FileJob {
    FileJob {
        remote,
        local,
        display,
        size: metadata.len(),
        mtime: metadata.mtime,
        permissions: metadata.permissions,
    }
}

/// 第二遍：流式遍历并把文件交给 worker；先建父目录再投递子项。
async fn produce(
    sftp: &SftpSession,
    roots: Vec<Root>,
    state: &TreeState,
    jobs: mpsc::Sender<FileJob>,
) {
    let mut pending: Vec<(String, PathBuf, String)> = Vec::new();
    for root in roots {
        match root.kind {
            RootKind::File(metadata) => {
                let job = file_job(root.remote, root.local, root.display, &metadata);
                if jobs.send(job).await.is_err() {
                    return;
                }
            }
            RootKind::Dir => {
                if let Err(reason) = ensure_local_dir(&root.local).await {
                    state.fail(root.remote, reason);
                    continue;
                }
                state
                    .local_roots
                    .lock()
                    .unwrap()
                    .push(root.local.to_string_lossy().into_owned());
                pending.push((root.remote, root.local, root.display));
            }
        }
    }
    while let Some((dir, local_dir, display_dir)) = pending.pop() {
        if state.cancel.is_canceled().await {
            return;
        }
        let entries = match sftp.read_dir(dir.clone()).await {
            Ok(entries) => entries,
            Err(error) => {
                state.fail(dir, format!("无法读取目录：{error}"));
                continue;
            }
        };
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join_remote(&dir, &name);
            if let Err(reason) = check_component(&name) {
                state.fail(path, reason);
                continue;
            }
            let local = local_dir.join(&name);
            let display = format!("{display_dir}/{name}");
            match classify(sftp, &path, entry.metadata()).await {
                Classified::Dir => match ensure_local_dir(&local).await {
                    Ok(()) => pending.push((path, local, display)),
                    Err(reason) => state.fail(path, reason),
                },
                Classified::File(metadata) => {
                    if jobs
                        .send(file_job(path, local, display, &metadata))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                Classified::Skip(reason) => state.skip(path, reason),
            }
        }
    }
}

fn temp_path(local: &Path) -> PathBuf {
    let name = local
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut short = random_name();
    short.truncate(8);
    local.with_file_name(format!(".{name}.dssh-part-{short}"))
}

enum Outcome {
    Downloaded,
    SkippedExisting,
}

/// 顺序读取一段远端区间写入本地同一区间；返回读到的字节数。
/// `len = None` 表示读到文件末尾，`expected` 为列目录时的大小：读满它且出现短读即视为
/// 到达末尾，省掉一次只为拿 EOF 的往返（文件若已变大，短读不会发生，照常继续读）。
#[allow(clippy::too_many_arguments)]
async fn copy_range(
    sftp: &SftpSession,
    remote: &str,
    temp: &Path,
    start: u64,
    len: Option<u64>,
    expected: u64,
    state: &TreeState,
    file_bytes: &AtomicU64,
) -> Result<u64, Error> {
    let mut source = sftp.open(remote).await?;
    let mut target = tokio::fs::OpenOptions::new().write(true).open(temp).await?;
    if start > 0 {
        source.seek(std::io::SeekFrom::Start(start)).await?;
        target.seek(std::io::SeekFrom::Start(start)).await?;
    }
    let mut buffer = vec![0_u8; READ_BUFFER];
    let mut copied = 0_u64;
    let result = async {
        loop {
            if state.cancel.is_canceled().await {
                return Err(Error::Canceled);
            }
            let want = match len {
                Some(len) if copied >= len => break,
                Some(len) => ((len - copied) as usize).min(buffer.len()),
                None => buffer.len(),
            };
            let read = source.read(&mut buffer[..want]).await?;
            if read == 0 {
                if matches!(len, Some(len) if copied < len) {
                    return Err(Error::Io("下载过程中远端文件被截断".into()));
                }
                break;
            }
            target.write_all(&buffer[..read]).await?;
            copied += read as u64;
            file_bytes.fetch_add(read as u64, Ordering::Relaxed);
            state.add_bytes(read as u64);
            if len.is_none() && read < want && copied >= expected {
                break;
            }
        }
        target.flush().await?;
        Ok::<u64, Error>(copied)
    }
    .await;
    // 只读句柄的关闭回执不影响数据完整性：放到后台等待，每个文件省一次往返。
    // 不能直接 drop：库只在收到关闭回执时归还句柄配额（limits@openssh.com），
    // 不等回执会很快耗尽配额（实测 "handle limit reached"）。
    tokio::spawn(async move {
        let _ = source.close().await;
    });
    result
}

fn apply_metadata(path: &Path, mtime: Option<u32>, permissions: Option<u32>) -> std::io::Result<()> {
    if let Some(mtime) = mtime {
        let file = std::fs::OpenOptions::new().write(true).open(path)?;
        let time = std::time::UNIX_EPOCH + Duration::from_secs(u64::from(mtime));
        file.set_times(std::fs::FileTimes::new().set_modified(time).set_accessed(time))?;
    }
    #[cfg(unix)]
    if let Some(mode) = permissions {
        use std::os::unix::fs::PermissionsExt;
        // 只保留 rwx 位，丢弃 setuid/setgid/sticky；保证属主可读写以便后续覆盖。
        std::fs::set_permissions(path, std::fs::Permissions::from_mode((mode & 0o777) | 0o600))?;
    }
    #[cfg(not(unix))]
    let _ = permissions;
    Ok(())
}

async fn download_file(
    sftp: &Arc<SftpSession>,
    job: &FileJob,
    policy: ConflictPolicy,
    state: &Arc<TreeState>,
) -> Result<Outcome, Error> {
    match tokio::fs::symlink_metadata(&job.local).await {
        Ok(metadata) if metadata.is_dir() => {
            return Err(Error::Io("本地已存在同名目录".into()));
        }
        Ok(_) if policy == ConflictPolicy::Skip => return Ok(Outcome::SkippedExisting),
        _ => {}
    }
    *state.current.lock().unwrap() = job.display.clone();
    let temp = temp_path(&job.local);
    let file_bytes = Arc::new(AtomicU64::new(0));
    let result = async {
        let file = tokio::fs::File::create(&temp).await?;
        if job.size >= LARGE_FILE_BYTES {
            file.set_len(job.size).await?;
            drop(file);
            let part = job.size.div_ceil(LARGE_FILE_RANGES);
            let mut tasks = tokio::task::JoinSet::new();
            let mut start = 0;
            while start < job.size {
                let len = part.min(job.size - start);
                let (sftp, state, file_bytes) = (sftp.clone(), state.clone(), file_bytes.clone());
                let (remote, temp) = (job.remote.clone(), temp.clone());
                tasks.spawn(async move {
                    copy_range(&sftp, &remote, &temp, start, Some(len), len, &state, &file_bytes).await
                });
                start += len;
            }
            while let Some(joined) = tasks.join_next().await {
                let outcome = joined.map_err(|error| Error::Io(error.to_string())).and_then(|r| r);
                if let Err(error) = outcome {
                    // 任一区间失败即放弃整个文件；等其余区间真正停下再删临时文件
                    // （Windows 上仍打开的文件无法删除）。
                    tasks.shutdown().await;
                    return Err(error);
                }
            }
        } else {
            drop(file);
            copy_range(sftp, &job.remote, &temp, 0, None, job.size, state, &file_bytes).await?;
        }
        apply_metadata(&temp, job.mtime, job.permissions)?;
        tokio::fs::rename(&temp, &job.local).await?;
        Ok::<(), Error>(())
    }
    .await;
    if let Err(error) = result {
        let _ = tokio::fs::remove_file(&temp).await;
        state.sub_bytes(file_bytes.load(Ordering::Relaxed));
        return Err(error);
    }
    Ok(Outcome::Downloaded)
}

async fn worker(
    sftp: Arc<SftpSession>,
    jobs: Arc<Mutex<mpsc::Receiver<FileJob>>>,
    policy: ConflictPolicy,
    state: Arc<TreeState>,
) {
    loop {
        let job = { jobs.lock().await.recv().await };
        let Some(job) = job else { return };
        if state.cancel.is_canceled().await {
            return;
        }
        match download_file(&sftp, &job, policy, &state).await {
            Ok(Outcome::Downloaded) => {
                state.downloaded_files.fetch_add(1, Ordering::Relaxed);
                state.complete();
            }
            Ok(Outcome::SkippedExisting) => {
                state.add_bytes(job.size);
                state.skipped_existing.fetch_add(1, Ordering::Relaxed);
                state.complete();
            }
            Err(Error::Canceled) => return,
            Err(error) => state.fail(job.remote.clone(), error.to_string()),
        }
    }
}

/// 核心流程，与 Tauri 解耦以便用本地 sftp-server 测试。
pub(crate) async fn download_tree(
    sftp: Arc<SftpSession>,
    remote_paths: &[String],
    local_dir: &Path,
    policy: ConflictPolicy,
    concurrency: usize,
    state: Arc<TreeState>,
) -> TreeSummary {
    let roots = resolve_roots(&sftp, remote_paths, local_dir, policy, &state).await;
    {
        let mut local_roots = state.local_roots.lock().unwrap();
        for root in &roots {
            if matches!(root.kind, RootKind::File(_)) {
                local_roots.push(root.local.to_string_lossy().into_owned());
            }
        }
    }
    scan(&sftp, &roots, &state).await;
    if !state.cancel.is_canceled().await {
        state.phase.store(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel(QUEUE_DEPTH);
        let receiver = Arc::new(Mutex::new(receiver));
        let workers: Vec<_> = (0..concurrency.clamp(1, MAX_CONCURRENCY))
            .map(|_| {
                tokio::spawn(worker(
                    sftp.clone(),
                    receiver.clone(),
                    policy,
                    state.clone(),
                ))
            })
            .collect();
        // 只让 worker 持有接收端：worker 全部因取消退出后，生产者的 send 立即失败而不是阻塞。
        drop(receiver);
        produce(&sftp, roots, &state, sender).await;
        for handle in workers {
            let _ = handle.await;
        }
    }
    state.phase.store(2, Ordering::Relaxed);
    state.current.lock().unwrap().clear();
    state.snapshot(true)
}

fn display_name(remote_paths: &[String]) -> String {
    let first = remote_paths
        .first()
        .and_then(|p| remote_basename(p))
        .unwrap_or("下载")
        .to_owned();
    if remote_paths.len() > 1 {
        format!("{first} 等 {} 项", remote_paths.len())
    } else {
        first
    }
}

fn emit_tree(
    app: &AppHandle,
    session_id: &str,
    transfer_id: &str,
    file_name: &str,
    summary: TreeSummary,
    done: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        &progress_event_name(session_id),
        TreeProgressPayload {
            transfer_id: transfer_id.to_owned(),
            direction: "download",
            file_name: file_name.to_owned(),
            transferred_bytes: summary.transferred_bytes,
            total_bytes: summary.total_bytes,
            done,
            error,
            tree: summary.tree,
        },
    );
}

/// 把远端文件 / 目录（可混合）递归下载到 `local_dir` 下，整体作为一个传输项上报进度。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_download_tree(
    app: AppHandle,
    state: State<'_, SshState>,
    session_id: String,
    remote_paths: Vec<String>,
    local_dir: String,
    transfer_id: String,
    policy: ConflictPolicy,
    concurrency: Option<usize>,
) -> Result<TreeSummary, Error> {
    let file_name = display_name(&remote_paths);
    let tree = Arc::new(TreeState::new(transfer_id.clone()));
    let result = async {
        let local_dir = PathBuf::from(&local_dir);
        if !local_dir.is_dir() {
            return Err(Error::Io("本地目标不是文件夹".into()));
        }
        if remote_paths.is_empty() {
            return Err(Error::Io("没有选择要下载的项目".into()));
        }
        let sftp = Arc::new(open_sftp(&state, &session_id).await?);
        // 进度定时上报：小文件很多时逐个发送事件会淹没前端。
        let ticker = {
            let (app, tree) = (app.clone(), tree.clone());
            let (session_id, transfer_id, file_name) =
                (session_id.clone(), transfer_id.clone(), file_name.clone());
            tokio::spawn(async move {
                loop {
                    emit_tree(&app, &session_id, &transfer_id, &file_name, tree.snapshot(false), false, None);
                    tokio::time::sleep(Duration::from_millis(150)).await;
                }
            })
        };
        let summary = download_tree(
            sftp.clone(),
            &remote_paths,
            &local_dir,
            policy,
            concurrency.unwrap_or(DEFAULT_CONCURRENCY),
            tree.clone(),
        )
        .await;
        ticker.abort();
        let _ = sftp.close().await;
        Ok(summary)
    }
    .await;
    match &result {
        Ok(summary) => emit_tree(&app, &session_id, &transfer_id, &file_name, summary.clone(), true, None),
        Err(error) => emit_tree(
            &app,
            &session_id,
            &transfer_id,
            &file_name,
            tree.snapshot(true),
            true,
            Some(error.to_string()),
        ),
    }
    clear_cancel_flag(&transfer_id).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_names_that_escape_or_are_invalid_locally() {
        for name in ["", ".", "..", "a/b", "nul\0"] {
            assert!(local_component(name, false).is_err(), "{name:?}");
            assert!(local_component(name, true).is_err(), "{name:?}");
        }
        for name in ["a\\b", "CON", "con.txt", "LPT1", "x:y", "trailing.", "trailing ", "q?"] {
            assert!(local_component(name, true).is_err(), "{name:?}");
        }
        for name in ["a\\b", "CON", "trailing.", "带 空格 & 'quote'.txt", "报告 (1).md", "$(id)"] {
            assert_eq!(local_component(name, false).unwrap(), name);
        }
        for name in ["COM0", "console.log", "报告 v2.txt", "LPT", ".bashrc"] {
            assert_eq!(local_component(name, true).unwrap(), name);
        }
    }

    #[test]
    fn joins_remote_paths_and_names_copies() {
        assert_eq!(join_remote("/", "a"), "/a");
        assert_eq!(join_remote("/srv/数据", "空 格.txt"), "/srv/数据/空 格.txt");
        assert_eq!(join_remote("/srv/", "x"), "/srv/x");
        assert_eq!(remote_basename("/srv/项目 一/"), Some("项目 一"));
        assert_eq!(remote_basename("/"), None);
        assert_eq!(numbered_name("报告.txt", 1, false), "报告 (1).txt");
        assert_eq!(numbered_name("archive.tar.gz", 2, false), "archive.tar (2).gz");
        assert_eq!(numbered_name(".bashrc", 1, false), ".bashrc (1)");
        assert_eq!(numbered_name("v1.2", 1, true), "v1.2 (1)");
        assert_eq!(display_name(&["/a/项目".into()]), "项目");
        assert_eq!(display_name(&["/a/项目".into(), "/a/b.txt".into()]), "项目 等 2 项");
    }

    #[test]
    fn conflict_query_suggests_free_numbered_names() {
        let tree = live::TempDir::new("conflicts");
        std::fs::create_dir(tree.0.join("项目")).unwrap();
        std::fs::create_dir(tree.0.join("项目 (1)")).unwrap();
        std::fs::write(tree.0.join("a.txt"), b"").unwrap();
        let conflicts = local_conflicts(
            &tree.0,
            &[("项目".into(), true), ("a.txt".into(), false), ("free".into(), false)],
        );
        assert_eq!(conflicts.len(), 2);
        assert_eq!(conflicts[0].rename_to, "项目 (2)");
        assert!(conflicts[0].is_dir);
        assert_eq!(conflicts[1].rename_to, "a (1).txt");
    }

    /// 用本机 OpenSSH `sftp-server` 通过 stdio 充当真实服务端，无需 sshd 或改系统配置。
    pub(super) mod live {
        use super::*;
        use std::process::Stdio;

        pub struct TempDir(pub PathBuf);
        impl TempDir {
            pub fn new(tag: &str) -> Self {
                let path = std::env::temp_dir().join(format!("dssh-tree-test-{tag}-{}", random_name()));
                std::fs::create_dir(&path).unwrap();
                Self(path)
            }
        }
        impl Drop for TempDir {
            fn drop(&mut self) {
                assert!(self
                    .0
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .starts_with("dssh-tree-test-"));
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        pub fn sftp_server() -> Option<&'static str> {
            ["/usr/lib/openssh/sftp-server", "/usr/libexec/openssh/sftp-server", "/usr/libexec/sftp-server"]
                .into_iter()
                .find(|p| Path::new(p).exists())
        }

        pub async fn connect() -> Option<(Arc<SftpSession>, tokio::process::Child)> {
            let Some(server) = sftp_server() else {
                eprintln!("跳过：本机没有 OpenSSH sftp-server");
                return None;
            };
            let mut process = tokio::process::Command::new(server)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let stream = tokio::io::join(process.stdout.take().unwrap(), process.stdin.take().unwrap());
            Some((Arc::new(SftpSession::new(stream).await.unwrap()), process))
        }

        pub fn md5ish(path: &Path) -> (u64, u64) {
            // 简单校验：长度 + FNV-1a，足以发现截断或错位写入。
            let bytes = std::fs::read(path).unwrap();
            let mut hash = 0xcbf29ce484222325_u64;
            for b in &bytes {
                hash ^= u64::from(*b);
                hash = hash.wrapping_mul(0x100000001b3);
            }
            (bytes.len() as u64, hash)
        }
    }

    use live::*;

    fn pattern(len: usize, seed: u8) -> Vec<u8> {
        (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
    }

    /// 构造远端树：中文、空格、特殊字符、嵌套、空目录、文件 / 目录 / 断开 / 循环链接、大文件。
    fn build_remote(root: &Path) {
        let base = root.join("项目 A");
        std::fs::create_dir_all(base.join("子目录/深 层/空目录")).unwrap();
        std::fs::write(base.join("说明.txt"), "你好").unwrap();
        std::fs::write(base.join("a b & 'c' $(x).md"), "special").unwrap();
        std::fs::write(base.join("子目录/zero.bin"), b"").unwrap();
        std::fs::write(base.join("子目录/深 层/data.bin"), pattern(100_000, 7)).unwrap();
        std::fs::write(base.join("large.bin"), pattern(17 * 1024 * 1024 + 123, 3)).unwrap();
        for i in 0..40 {
            std::fs::write(base.join(format!("子目录/small-{i}.txt")), format!("file {i}")).unwrap();
        }
        let link = |target: &str, name: &str| std::os::unix::fs::symlink(target, base.join(name)).unwrap();
        link("子目录", "dir-link");
        link("..", "loop-link");
        link("说明.txt", "file-link.txt");
        link("missing-target", "broken-link");
        let time = std::time::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        std::fs::File::options()
            .write(true)
            .open(base.join("说明.txt"))
            .unwrap()
            .set_modified(time)
            .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(base.join("a b & 'c' $(x).md"), std::fs::Permissions::from_mode(0o640)).unwrap();
    }

    fn remote_str(path: PathBuf) -> String {
        path.to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn downloads_tree_with_links_metadata_and_conflict_policies() {
        let Some((sftp, _process)) = connect().await else { return };
        let remote = TempDir::new("remote");
        let local = TempDir::new("local");
        build_remote(&remote.0);
        let source = remote.0.join("项目 A");
        let roots = vec![remote_str(source.clone()), remote_str(remote.0.join("项目 A/说明.txt"))];

        let state = Arc::new(TreeState::new(format!("tree-{}", random_name())));
        let summary = download_tree(sftp.clone(), &roots, &local.0, ConflictPolicy::Overwrite, 4, state).await;
        let target = local.0.join("项目 A");
        // 40 small + 说明 + special + zero + data + large + file-link + 顶层说明.txt
        assert_eq!(summary.tree.total_files, 47, "{summary:?}");
        assert_eq!(summary.tree.completed_files, 47);
        assert_eq!(summary.tree.failure_count, 0, "{:?}", summary.tree.failures);
        assert_eq!(summary.transferred_bytes, summary.total_bytes);
        let mut skipped: Vec<_> = summary.tree.skipped.iter().map(|i| remote_basename(&i.path).unwrap().to_owned()).collect();
        skipped.sort();
        assert_eq!(skipped, ["broken-link", "dir-link", "loop-link"]);
        for rel in ["说明.txt", "a b & 'c' $(x).md", "子目录/zero.bin", "子目录/深 层/data.bin", "large.bin", "子目录/small-39.txt"] {
            assert_eq!(md5ish(&source.join(rel)), md5ish(&target.join(rel)), "{rel}");
        }
        assert!(target.join("子目录/深 层/空目录").is_dir());
        assert!(!target.join("dir-link").exists() && !target.join("loop-link").exists());
        let file_link = std::fs::symlink_metadata(target.join("file-link.txt")).unwrap();
        assert!(file_link.is_file(), "文件链接应下载为普通文件");
        assert_eq!(std::fs::read(target.join("file-link.txt")).unwrap(), "你好".as_bytes());
        assert_eq!(std::fs::read(local.0.join("说明.txt")).unwrap(), "你好".as_bytes());
        let mtime = std::fs::metadata(target.join("说明.txt")).unwrap().modified().unwrap();
        assert_eq!(mtime, std::time::UNIX_EPOCH + Duration::from_secs(1_600_000_000));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(target.join("a b & 'c' $(x).md")).unwrap().permissions().mode() & 0o777, 0o640);
        let leftovers: Vec<_> = walk(&local.0).into_iter().filter(|p| p.contains(".dssh-part-")).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");

        // Skip：本地修改过的文件保持不变，缺失文件补齐。
        std::fs::write(target.join("说明.txt"), "local edit").unwrap();
        std::fs::remove_file(target.join("子目录/small-0.txt")).unwrap();
        let state = Arc::new(TreeState::new(format!("tree-{}", random_name())));
        let summary = download_tree(sftp.clone(), &roots[..1], &local.0, ConflictPolicy::Skip, 2, state).await;
        assert_eq!(summary.tree.downloaded_files, 1);
        assert_eq!(summary.tree.skipped_existing, 45);
        assert_eq!(std::fs::read(target.join("说明.txt")).unwrap(), b"local edit");
        assert!(target.join("子目录/small-0.txt").exists());

        // Overwrite：覆盖本地修改。
        let state = Arc::new(TreeState::new(format!("tree-{}", random_name())));
        download_tree(sftp.clone(), &roots[..1], &local.0, ConflictPolicy::Overwrite, 4, state).await;
        assert_eq!(std::fs::read(target.join("说明.txt")).unwrap(), "你好".as_bytes());

        // Rename：另存为 “项目 A (1)”，原目录不动。
        let state = Arc::new(TreeState::new(format!("tree-{}", random_name())));
        let summary = download_tree(sftp.clone(), &roots[..1], &local.0, ConflictPolicy::Rename, 4, state).await;
        assert_eq!(summary.tree.local_roots, [remote_str(local.0.join("项目 A (1)"))]);
        assert_eq!(md5ish(&source.join("large.bin")), md5ish(&local.0.join("项目 A (1)/large.bin")));

        // 本地同名项是文件时不能合并目录。
        std::fs::write(local.0.join("blocked"), b"keep").unwrap();
        std::fs::create_dir(remote.0.join("blocked")).unwrap();
        let state = Arc::new(TreeState::new(format!("tree-{}", random_name())));
        let summary = download_tree(sftp.clone(), &[remote_str(remote.0.join("blocked"))], &local.0, ConflictPolicy::Overwrite, 4, state).await;
        assert_eq!(summary.tree.failure_count, 1);
        assert_eq!(std::fs::read(local.0.join("blocked")).unwrap(), b"keep");
    }

    fn walk(dir: &Path) -> Vec<String> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            out.push(path.to_string_lossy().into_owned());
            if std::fs::symlink_metadata(&path).unwrap().is_dir() {
                out.extend(walk(&path));
            }
        }
        out
    }

    #[tokio::test]
    async fn unreadable_entries_fail_individually_and_the_rest_continues() {
        let Some((sftp, _process)) = connect().await else { return };
        if running_as_root() {
            eprintln!("跳过：root 不受权限位限制");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let remote = TempDir::new("perm-remote");
        let local = TempDir::new("perm-local");
        let base = remote.0.join("perm");
        std::fs::create_dir_all(base.join("locked")).unwrap();
        std::fs::write(base.join("locked/inner.txt"), b"x").unwrap();
        std::fs::write(base.join("secret.txt"), b"x").unwrap();
        std::fs::write(base.join("ok.txt"), b"ok").unwrap();
        std::fs::set_permissions(base.join("secret.txt"), std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(base.join("locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let state = Arc::new(TreeState::new(format!("tree-{}", random_name())));
        let summary = download_tree(sftp, &[remote_str(base.clone())], &local.0, ConflictPolicy::Overwrite, 4, state).await;
        std::fs::set_permissions(base.join("locked"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(summary.tree.failure_count, 2, "{:?}", summary.tree.failures);
        assert_eq!(summary.tree.downloaded_files, 1);
        assert_eq!(std::fs::read(local.0.join("perm/ok.txt")).unwrap(), b"ok");
        assert!(!local.0.join("perm/secret.txt").exists());
        assert!(walk(&local.0).iter().all(|p| !p.contains(".dssh-part-")));
    }

    fn running_as_root() -> bool {
        std::env::var("USER").map(|u| u == "root").unwrap_or(false)
    }

    #[tokio::test]
    async fn cancel_stops_queue_removes_partial_file_and_keeps_completed_files() {
        let Some((sftp, _process)) = connect().await else { return };
        let remote = TempDir::new("cancel-remote");
        let local = TempDir::new("cancel-local");
        let base = remote.0.join("取消 测试");
        std::fs::create_dir_all(&base).unwrap();
        for i in 0..20 {
            std::fs::write(base.join(format!("a-{i:02}.txt")), pattern(1000, i)).unwrap();
        }
        // 足够大的文件保证取消发生在它写到一半时。
        std::fs::write(base.join("z-huge.bin"), pattern(300 * 1024 * 1024, 9)).unwrap();
        let id = format!("tree-cancel-{}", random_name());
        let state = Arc::new(TreeState::new(id.clone()));
        let watcher = {
            let state = state.clone();
            tokio::spawn(async move {
                // 小文件总共只有 20 KB，超过 8 MB 说明大文件正写到一半。
                while state.transferred_bytes.load(Ordering::Relaxed) < 8 * 1024 * 1024 {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
                crate::sftp::canceled_transfers().lock().await.insert(id);
            })
        };
        let summary = download_tree(sftp, &[remote_str(base.clone())], &local.0, ConflictPolicy::Overwrite, 1, state).await;
        watcher.await.unwrap();
        assert!(summary.tree.canceled);
        assert_eq!(summary.tree.total_files, 21);
        // readdir 顺序不定：大文件之前的小文件已完成，之后的停止不再下载。
        let target = local.0.join("取消 测试");
        let mut completed = 0;
        for i in 0..20 {
            let name = format!("a-{i:02}.txt");
            if target.join(&name).exists() {
                assert_eq!(md5ish(&base.join(&name)), md5ish(&target.join(&name)));
                completed += 1;
            }
        }
        assert!(completed < 21);
        assert_eq!(summary.tree.completed_files, completed, "{summary:?}");
        assert!(!target.join("z-huge.bin").exists());
        assert!(walk(&local.0).iter().all(|p| !p.contains(".dssh-part-")), "{:?}", walk(&local.0));
        // 半成品字节不计入已传输。
        assert_eq!(summary.transferred_bytes, 1000 * completed);
    }

    #[tokio::test]
    async fn cancel_before_transfer_phase_downloads_nothing() {
        let Some((sftp, _process)) = connect().await else { return };
        let remote = TempDir::new("precancel-remote");
        let local = TempDir::new("precancel-local");
        std::fs::create_dir(remote.0.join("d")).unwrap();
        std::fs::write(remote.0.join("d/x"), b"x").unwrap();
        let id = format!("tree-pre-{}", random_name());
        crate::sftp::canceled_transfers().lock().await.insert(id.clone());
        let state = Arc::new(TreeState::new(id));
        let summary = download_tree(sftp, &[remote_str(remote.0.join("d"))], &local.0, ConflictPolicy::Overwrite, 4, state).await;
        assert!(summary.tree.canceled);
        assert_eq!(summary.tree.completed_files, 0);
        assert!(!local.0.join("d").exists());
    }

    /// 真实服务器验证：经系统 ssh 打开 sftp 子系统（与应用里 channel → SftpSession 同一协议路径），
    /// 调用同一个 `download_tree`。用法见 docs/file-workspace.md。
    #[tokio::test]
    #[ignore = "需要 DSSH_LIVE_SSH_HOST / DSSH_LIVE_REMOTE / DSSH_LIVE_LOCAL"]
    async fn live_server_folder_download() {
        use std::process::Stdio;
        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("缺少环境变量 {key}"));
        let (host, remote, local) = (env("DSSH_LIVE_SSH_HOST"), env("DSSH_LIVE_REMOTE"), env("DSSH_LIVE_LOCAL"));
        let concurrency = std::env::var("DSSH_LIVE_CONCURRENCY").ok().and_then(|v| v.parse().ok()).unwrap_or(DEFAULT_CONCURRENCY);
        let cancel_after: Option<u64> = std::env::var("DSSH_LIVE_CANCEL_AFTER").ok().and_then(|v| v.parse().ok());
        let policy = match std::env::var("DSSH_LIVE_POLICY").as_deref() {
            Ok("skip") => ConflictPolicy::Skip,
            Ok("rename") => ConflictPolicy::Rename,
            _ => ConflictPolicy::Overwrite,
        };
        // host = "local"：本机 sftp-server（区分网络与客户端开销）；
        // 设置 DSSH_LIVE_SSH_KEY：走应用自己的 russh 连接（connect_handle，nodelay）+ sftp 子系统，
        // 与 open_sftp 完全相同；否则退回系统 ssh -s sftp。
        let mut _process = None;
        let mut _handle = None;
        let sftp = if host == "local" {
            let mut process = tokio::process::Command::new(sftp_server().unwrap())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let stream = tokio::io::join(process.stdout.take().unwrap(), process.stdin.take().unwrap());
            _process = Some(process);
            SftpSession::new(stream).await.unwrap()
        } else if let Ok(key) = std::env::var("DSSH_LIVE_SSH_KEY") {
            let (user, rest) = host.split_once('@').expect("DSSH_LIVE_SSH_HOST 形如 user@host:port");
            let (address, port) = rest.rsplit_once(':').unwrap_or((rest, "22"));
            let handle = crate::ssh::connect_handle(&crate::ssh::ConnectParams {
                host: address.into(),
                port: port.parse().unwrap(),
                username: user.into(),
                auth_method: "publicKey".into(),
                secret: Some(key),
                passphrase: None,
                server_id: None,
                cols: 80,
                rows: 24,
                tmux: None,
                tmux_workdir: None,
            })
            .await
            .unwrap_or_else(|error| panic!("连接失败：{error}"));
            let channel = handle.channel_open_session().await.unwrap();
            channel.request_subsystem(true, "sftp").await.unwrap();
            _handle = Some(handle);
            SftpSession::new(channel.into_stream()).await.unwrap()
        } else {
            let mut process = tokio::process::Command::new("ssh")
                .args(["-o", "BatchMode=yes", &host, "-s", "sftp"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let stream = tokio::io::join(process.stdout.take().unwrap(), process.stdin.take().unwrap());
            _process = Some(process);
            SftpSession::new(stream).await.unwrap()
        };
        let sftp = Arc::new(sftp);
        let id = format!("live-{}", random_name());
        let state = Arc::new(TreeState::new(id.clone()));
        let started = std::time::Instant::now();
        let reporter = {
            let state = state.clone();
            tokio::spawn(async move {
                let mut scan_logged = false;
                loop {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    let s = state.snapshot(false);
                    if s.tree.phase != "scanning" && !scan_logged {
                        scan_logged = true;
                        eprintln!("[{:>6.1}s] 统计完成：{} 个文件 / {} 字节", started.elapsed().as_secs_f64(), s.tree.total_files, s.total_bytes);
                    }
                    eprintln!("[{:>6.1}s] {} {}/{} 文件 {}/{} 字节 当前 {}", started.elapsed().as_secs_f64(), s.tree.phase, s.tree.completed_files, s.tree.total_files, s.transferred_bytes, s.total_bytes, s.tree.current_file);
                    if let Some(limit) = cancel_after {
                        if s.transferred_bytes >= limit {
                            crate::sftp::canceled_transfers().lock().await.insert(id.clone());
                        }
                    }
                }
            })
        };
        let summary = download_tree(sftp.clone(), &[remote], Path::new(&local), policy, concurrency, state).await;
        reporter.abort();
        let elapsed = started.elapsed().as_secs_f64();
        eprintln!(
            "结果：用时 {elapsed:.1}s，{} 并发，{}/{} 文件（下载 {}，跳过已存在 {}），{} 字节，{:.1} MB/s，失败 {}，跳过 {}，取消 {}",
            concurrency,
            summary.tree.completed_files,
            summary.tree.total_files,
            summary.tree.downloaded_files,
            summary.tree.skipped_existing,
            summary.transferred_bytes,
            summary.transferred_bytes as f64 / elapsed / 1048576.0,
            summary.tree.failure_count,
            summary.tree.skipped_count,
            summary.tree.canceled
        );
        for issue in summary.tree.failures.iter().chain(&summary.tree.skipped) {
            eprintln!("  {} — {}", issue.path, issue.reason);
        }
        let _ = sftp.close().await;
    }
}
