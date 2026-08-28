//! SSH 会话管理（russh）
//!
//! 数据流：
//!   远程主机 ←→ russh channel ←→ Tauri event `ssh://{session_id}/data|exit` ←→ 前端 ghostty-web

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::{PrivateKeyWithHashAlg, load_secret_key};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// 服务器连接参数（与前端 ServerEntry 对应）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 认证方式：password / publicKey
    pub auth_method: String,
    /// password 模式为密码；publicKey 模式为私钥路径
    pub secret: Option<String>,
    /// 私钥 passphrase（可选）
    pub passphrase: Option<String>,
    /// 关联的服务器条目 id：secret/passphrase 为空时自动从 keyring 取
    pub server_id: Option<String>,
    pub cols: u32,
    pub rows: u32,
}

type ClientHandle = russh::client::Handle<SshHandler>;
type WriteHalf = russh::ChannelWriteHalf<russh::client::Msg>;

/// 供 sftp/forward/monitor 等模块共享的连接句柄
pub type SharedHandle = Arc<ClientHandle>;

/// 会话的连接元数据（remote 转发重建辅助连接时用）
#[derive(Debug, Clone)]
pub struct SessionMeta {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    /// publicKey 模式的私钥路径（密码在 keyring，不落这里）
    pub key_path: Option<String>,
    pub server_id: Option<String>,
}

pub struct Session {
    write_half: WriteHalf,
    handle: SharedHandle,
    meta: SessionMeta,
}

#[derive(Default)]
pub struct SshState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

impl SshState {
    /// 取会话的共享连接句柄（russh Handle 的 channel 打开/转发等方法是 &self）
    pub async fn get_handle(&self, session_id: &str) -> Option<SharedHandle> {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .map(|s| s.handle.clone())
    }

    /// 取会话的连接元数据
    pub async fn get_meta(&self, session_id: &str) -> Option<SessionMeta> {
        self.sessions.lock().await.get(session_id).map(|s| s.meta.clone())
    }

    /// 当前存活会话数
    #[allow(dead_code)] // 后续会话管理 UI 用
    pub async fn session_count(&self) -> usize {
        self.sessions.lock().await.len()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("会话不存在: {0}（可能已断开）")]
    NotFound(String),
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for SshError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl From<russh::Error> for SshError {
    fn from(e: russh::Error) -> Self {
        SshError::Other(e.to_string())
    }
}

impl From<russh::keys::Error> for SshError {
    fn from(e: russh::keys::Error) -> Self {
        SshError::Other(format!("私钥加载失败: {e}"))
    }
}

/// 主机密钥校验：MVP 阶段全部接受（个人自用场景）
// TODO(M2): known_hosts 持久化校验 + 首次连接指纹确认弹窗
pub(crate) struct SshHandler;

impl russh::client::Handler for SshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 增量 UTF-8 解码：避免跨 chunk 的多字节字符被 from_utf8_lossy 切碎
#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(s) => {
                let out = s.to_owned();
                self.pending.clear();
                out
            }
            Err(e) => {
                let valid = e.valid_up_to();
                let out = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                let rest = &self.pending[valid..];
                match e.error_len() {
                    // 不完整的多字节尾部：留到下一次
                    None => self.pending = rest.to_vec(),
                    // 非法字节：跳过并继续（lossy 已输出替换符）
                    Some(len) => self.pending = rest[len..].to_vec(),
                }
                out
            }
        }
    }
}

/// 建立 SSH 会话，返回 session_id；输出通过事件推送
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    params: ConnectParams,
) -> Result<String, SshError> {
    tracing::info!(
        "ssh_connect {}@{}:{} ({})",
        params.username,
        params.host,
        params.port,
        params.auth_method
    );

    let config = Arc::new(russh::client::Config {
        // 不主动断连；每 15s 发 keepalive 防 NAT/防火墙断线
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        nodelay: true,
        ..Default::default()
    });

    let mut handle = russh::client::connect(
        config,
        (params.host.as_str(), params.port),
        SshHandler,
    )
    .await
    .map_err(|e| SshError::Other(format!("连接失败（网络/超时）: {e}")))?;

    // ---- 认证（secret/passphrase 为空且有关联服务器条目时，从 keyring 取） ----
    let resolved_secret = match &params.secret {
        Some(s) if !s.is_empty() => params.secret.clone(),
        _ => params
            .server_id
            .as_deref()
            .and_then(|id| crate::servers::get_secret(id, "password")),
    };
    let resolved_passphrase = match &params.passphrase {
        Some(s) if !s.is_empty() => params.passphrase.clone(),
        _ => params
            .server_id
            .as_deref()
            .and_then(|id| crate::servers::get_secret(id, "passphrase")),
    };

    let auth_result = match params.auth_method.as_str() {
        "password" => {
            let password = resolved_secret.clone().unwrap_or_default();
            handle
                .authenticate_password(params.username.clone(), password)
                .await
                .map_err(SshError::from)?
        }
        "publicKey" => {
            let key_path = resolved_secret
                .clone()
                .ok_or_else(|| SshError::Other("缺少私钥路径".into()))?;
            let key = load_secret_key(&key_path, resolved_passphrase.as_deref())?;
            handle
                .authenticate_publickey(
                    params.username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(SshError::from)?
        }
        other => return Err(SshError::Other(format!("不支持的认证方式: {other}"))),
    };

    if !auth_result.success() {
        return Err(SshError::Other("认证失败：用户名或密码/密钥不正确".into()));
    }

    // ---- 打开交互式 shell 通道 ----
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(false, "xterm-256color", params.cols, params.rows, 0, 0, &[])
        .await?;
    // 真彩色支持声明（部分服务器拒绝 set_env，忽略错误）
    let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
    // 用 exec 代替 request_shell：通过 env 前缀注入终端能力声明，
    // 不受服务端 sshd AcceptEnv 白名单限制。
    // TERM_PROGRAM=ghostty 声明本终端支持 Kitty graphics protocol
    //（pi 等现代工具依据该变量决定是否内联显示图片）。
    channel
        .exec(
            false,
            "env TERM_PROGRAM=ghostty COLORTERM=truecolor ${SHELL:-/bin/bash} -l",
        )
        .await?;

    let (mut read_half, write_half) = channel.split();

    let session_id = uuid_v4();

    // ---- 读循环：远端输出 → 前端事件 ----
    {
        let app = app.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let mut decoder = Utf8Decoder::default();
            let data_event = format!("ssh://{sid}/data");
            let exit_event = format!("ssh://{sid}/exit");
            // ExitStatus 后仍可能收到 EOF/Close；只通知一次，避免前端把一次
            // 正常退出误判成两次断线。没有退出码时统一用 -1 表示连接断开。
            let mut exit_emitted = false;
            loop {
                match read_half.wait().await {
                    Some(russh::ChannelMsg::Data { data })
                    | Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        let text = decoder.push(&data);
                        if !text.is_empty() {
                            let _ = app.emit(&data_event, text);
                        }
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => {
                        let _ = app.emit(&exit_event, exit_status as i64);
                        exit_emitted = true;
                    }
                    Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            // EOF/Close/None 覆盖对端主动关闭、网络中断及 keepalive 失败后的
            // russh 通道结束路径；没有 ExitStatus 时也必须通知前端重连。
            if !exit_emitted {
                let _ = app.emit(&exit_event, -1i64);
            }
            tracing::info!("ssh session {sid} read loop ended");
        });
    }

    state.sessions.lock().await.insert(
        session_id.clone(),
        Session {
            write_half,
            handle: Arc::new(handle),
            meta: SessionMeta {
                host: params.host.clone(),
                port: params.port,
                username: params.username.clone(),
                auth_method: params.auth_method.clone(),
                key_path: if params.auth_method == "publicKey" {
                    params.secret.clone()
                } else {
                    None
                },
                server_id: params.server_id.clone(),
            },
        },
    );

    Ok(session_id)
}

/// 前端终端输入 → SSH channel
#[tauri::command]
pub async fn ssh_write(
    state: State<'_, SshState>,
    session_id: String,
    data: String,
) -> Result<(), SshError> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    session
        .write_half
        .data(data.as_bytes())
        .await
        .map_err(|e| SshError::Other(format!("写入失败: {e}")))?;
    Ok(())
}

/// 终端尺寸变化 → SSH pty resize
#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, SshState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), SshError> {
    let sessions = state.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| SshError::NotFound(session_id.clone()))?;
    session
        .write_half
        .window_change(cols, rows, 0, 0)
        .await
        .map_err(SshError::from)?;
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, SshState>,
    session_id: String,
) -> Result<(), SshError> {
    if let Some(session) = state.sessions.lock().await.remove(&session_id) {
        let _ = session.write_half.close().await;
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "dssh disconnect", "en")
            .await;
    }
    Ok(())
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}", nanos, std::process::id())
}
