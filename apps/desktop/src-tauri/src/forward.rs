//! Local, remote and dynamic (SOCKS5) SSH port forwarding.
//!
//! Local and dynamic forwards reuse the authenticated terminal session.  A remote
//! forward uses a small, separate SSH client because the terminal handler is not
//! able to receive forwarded channels.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handler;
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

use crate::ssh::SshState;

/// A forwarding rule.  `remote_host`/`remote_port` are the destination for a
/// local or SOCKS forward, and the listening address/port for a remote forward.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardRule {
    pub rule_type: ForwardType,
    pub local_host: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ForwardType {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub rule_id: String,
    pub session_id: String,
    pub rule: ForwardRule,
    pub running: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ForwardError {
    #[error("会话不存在: {0}")]
    SessionNotFound(String),
    #[error("转发规则不存在: {0}")]
    RuleNotFound(String),
    #[error("转发规则无效: {0}")]
    InvalidRule(String),
    #[error("{0}")]
    Other(String),
}

impl Serialize for ForwardError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<std::io::Error> for ForwardError {
    fn from(error: std::io::Error) -> Self {
        Self::Other(error.to_string())
    }
}

impl From<russh::Error> for ForwardError {
    fn from(error: russh::Error) -> Self {
        Self::Other(error.to_string())
    }
}

struct RunningForward {
    session_id: String,
    rule: ForwardRule,
    stop: oneshot::Sender<()>,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Default)]
pub struct ForwardState {
    rules: Mutex<HashMap<String, RunningForward>>,
}

fn new_rule_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("forward-{nanos:x}-{}", std::process::id())
}

fn validate_rule(rule: &ForwardRule) -> Result<(), ForwardError> {
    if rule.local_host.trim().is_empty() {
        return Err(ForwardError::InvalidRule("本地地址不能为空".into()));
    }
    if matches!(rule.rule_type, ForwardType::Local | ForwardType::Remote)
        && rule.remote_host.trim().is_empty()
    {
        return Err(ForwardError::InvalidRule("远程地址不能为空".into()));
    }
    if rule.local_port == 0 && matches!(rule.rule_type, ForwardType::Local | ForwardType::Dynamic) {
        return Err(ForwardError::InvalidRule("本地端口不能为 0".into()));
    }
    if rule.remote_port == 0 && matches!(rule.rule_type, ForwardType::Local | ForwardType::Dynamic) {
        return Err(ForwardError::InvalidRule("远程端口不能为 0".into()));
    }
    Ok(())
}

/// Start one forwarding rule and return its id.
///
/// 连接参数（主机/认证）全部从会话元数据推导：local/dynamic 复用会话句柄，
/// remote 用元数据 + keyring 建辅助连接。前端只需传 sessionId + rule。
#[tauri::command]
pub async fn forward_start(
    state: State<'_, ForwardState>,
    ssh_state: State<'_, SshState>,
    session_id: String,
    rule: ForwardRule,
) -> Result<String, ForwardError> {
    validate_rule(&rule)?;
    let rule_id = new_rule_id();
    let (stop, stop_rx) = oneshot::channel();

    let task = match rule.rule_type {
        ForwardType::Local => {
            let handle = ssh_state
                .get_handle(&session_id)
                .await
                .ok_or_else(|| ForwardError::SessionNotFound(session_id.clone()))?;
            let listener = TcpListener::bind((rule.local_host.as_str(), rule.local_port))
                .await
                .map_err(|error| ForwardError::Other(format!("绑定本地端口失败: {error}")))?;
            tokio::spawn(run_local(listener, handle, rule.clone(), stop_rx))
        }
        ForwardType::Dynamic => {
            let handle = ssh_state
                .get_handle(&session_id)
                .await
                .ok_or_else(|| ForwardError::SessionNotFound(session_id.clone()))?;
            let listener = TcpListener::bind((rule.local_host.as_str(), rule.local_port))
                .await
                .map_err(|error| ForwardError::Other(format!("绑定 SOCKS5 端口失败: {error}")))?;
            tokio::spawn(run_dynamic(listener, handle, stop_rx))
        }
        ForwardType::Remote => {
            let meta = ssh_state
                .get_meta(&session_id)
                .await
                .ok_or_else(|| ForwardError::SessionNotFound(session_id.clone()))?;
            // 密码/passphrase 从 keyring 解析；私钥路径来自会话元数据
            let (secret, passphrase) = match meta.auth_method.as_str() {
                "password" => (
                    meta.server_id
                        .as_deref()
                        .and_then(|id| crate::servers::get_secret(id, "password")),
                    None,
                ),
                "publicKey" => (
                    meta.key_path.clone(),
                    meta.server_id
                        .as_deref()
                        .and_then(|id| crate::servers::get_secret(id, "passphrase")),
                ),
                other => {
                    return Err(ForwardError::InvalidRule(format!(
                        "不支持的认证方式: {other}"
                    )))
                }
            };
            tokio::spawn(run_remote(
                meta.host,
                meta.port,
                meta.username,
                meta.auth_method,
                secret,
                passphrase,
                rule.clone(),
                stop_rx,
            ))
        }
    };

    state.rules.lock().await.insert(
        rule_id.clone(),
        RunningForward {
            session_id,
            rule,
            stop,
            task,
        },
    );
    Ok(rule_id)
}

/// Stop a rule.  Stopping removes it from the active rule list; deleting a UI
/// row therefore does not need a second backend command.
#[tauri::command]
pub async fn forward_stop(
    state: State<'_, ForwardState>,
    rule_id: String,
) -> Result<(), ForwardError> {
    let entry = state
        .rules
        .lock()
        .await
        .remove(&rule_id)
        .ok_or_else(|| ForwardError::RuleNotFound(rule_id.clone()))?;
    stop_entry(entry).await;
    Ok(())
}

async fn stop_entry(entry: RunningForward) {
    let _ = entry.stop.send(());
    if let Err(error) = entry.task.await {
        if !error.is_cancelled() {
            tracing::warn!("port forward task ended with error: {error}");
        }
    }
}

#[tauri::command]
pub async fn forward_list(
    state: State<'_, ForwardState>,
    session_id: String,
) -> Result<Vec<ForwardStatus>, ForwardError> {
    let mut rules = state.rules.lock().await;
    // A failed listener/authentication task must not leave a permanently
    // "running" row in the UI.
    rules.retain(|_, entry| !entry.task.is_finished());
    Ok(rules
        .iter()
        .filter(|(_, entry)| entry.session_id == session_id)
        .map(|(rule_id, entry)| ForwardStatus {
            rule_id: rule_id.clone(),
            session_id: entry.session_id.clone(),
            rule: entry.rule.clone(),
            running: !entry.task.is_finished(),
        })
        .collect())
}

/// Convenience cleanup for the session-disconnect path.
#[tauri::command]
pub async fn forward_stop_session(
    state: State<'_, ForwardState>,
    session_id: String,
) -> Result<(), ForwardError> {
    let entries: Vec<_> = {
        let mut rules = state.rules.lock().await;
        let ids: Vec<String> = rules
            .iter()
            .filter(|(_, entry)| entry.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter().filter_map(|id| rules.remove(&id)).collect()
    };
    for entry in entries {
        stop_entry(entry).await;
    }
    Ok(())
}

async fn run_local(
    listener: TcpListener,
    handle: crate::ssh::SharedHandle,
    rule: ForwardRule,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        let accepted = tokio::select! {
            _ = &mut stop => break,
            result = listener.accept() => result,
        };
        let (mut tcp, _) = match accepted {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!("local forward accept failed: {error}");
                break;
            }
        };
        let handle = handle.clone();
        let host = rule.remote_host.clone();
        let port = rule.remote_port;
        tokio::spawn(async move {
            match handle
                .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
                .await
            {
                Ok(channel) => {
                    let mut channel = channel.into_stream();
                    if let Err(error) = tokio::io::copy_bidirectional(&mut tcp, &mut channel).await
                    {
                        tracing::warn!("local forward connection failed: {error}");
                    }
                }
                Err(error) => tracing::warn!("opening local forward channel failed: {error}"),
            }
        });
    }
}

async fn run_dynamic(
    listener: TcpListener,
    handle: crate::ssh::SharedHandle,
    mut stop: oneshot::Receiver<()>,
) {
    loop {
        let accepted = tokio::select! {
            _ = &mut stop => break,
            result = listener.accept() => result,
        };
        let (tcp, _) = match accepted {
            Ok(pair) => pair,
            Err(error) => {
                tracing::warn!("SOCKS5 accept failed: {error}");
                break;
            }
        };
        let handle = handle.clone();
        tokio::spawn(async move {
            if let Err(error) = socks5_connection(tcp, handle).await {
                tracing::warn!("SOCKS5 connection failed: {error}");
            }
        });
    }
}

async fn socks5_connection(
    mut tcp: TcpStream,
    handle: crate::ssh::SharedHandle,
) -> Result<(), ForwardError> {
    let version = tcp.read_u8().await?;
    let methods = tcp.read_u8().await?;
    if version != 5 {
        return Err(ForwardError::Other("SOCKS5 版本不受支持".into()));
    }
    let mut method_list = vec![0u8; methods as usize];
    tcp.read_exact(&mut method_list).await?;
    if !method_list.contains(&0) {
        tcp.write_all(&[5, 0xff]).await?;
        return Err(ForwardError::Other("SOCKS5 仅支持无认证模式".into()));
    }
    tcp.write_all(&[5, 0]).await?;

    if tcp.read_u8().await? != 5 {
        return Err(ForwardError::Other("SOCKS5 请求版本不受支持".into()));
    }
    let command = tcp.read_u8().await?;
    let _reserved = tcp.read_u8().await?;
    let address_type = tcp.read_u8().await?;
    if command != 1 {
        send_socks_reply(&mut tcp, 7).await?; // command not supported
        return Err(ForwardError::Other("SOCKS5 只支持 CONNECT".into()));
    }
    let target_host = match address_type {
        1 => {
            let mut address = [0u8; 4];
            tcp.read_exact(&mut address).await?;
            IpAddr::from(address).to_string()
        }
        3 => {
            let length = tcp.read_u8().await? as usize;
            let mut name = vec![0u8; length];
            tcp.read_exact(&mut name).await?;
            String::from_utf8(name)
                .map_err(|_| ForwardError::Other("SOCKS5 域名不是 UTF-8".into()))?
        }
        4 => {
            let mut address = [0u8; 16];
            tcp.read_exact(&mut address).await?;
            IpAddr::from(address).to_string()
        }
        _ => {
            send_socks_reply(&mut tcp, 8).await?; // address type not supported
            return Err(ForwardError::Other("SOCKS5 地址类型不受支持".into()));
        }
    };
    let target_port = tcp.read_u16().await?;

    let channel = match handle
        .channel_open_direct_tcpip(target_host, target_port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(channel) => channel,
        Err(error) => {
            send_socks_reply(&mut tcp, 5).await?; // connection refused
            return Err(error.into());
        }
    };
    send_socks_reply(&mut tcp, 0).await?;
    let mut channel = channel.into_stream();
    tokio::io::copy_bidirectional(&mut tcp, &mut channel).await?;
    Ok(())
}

async fn send_socks_reply(tcp: &mut TcpStream, status: u8) -> Result<(), std::io::Error> {
    // IPv4 zero address and zero port are valid placeholders in a reply.
    tcp.write_all(&[5, status, 0, 1, 0, 0, 0, 0, 0, 0]).await
}

#[derive(Clone)]
struct RemoteHandler {
    local_host: String,
    local_port: u16,
}

impl Handler for RemoteHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<russh::client::Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        let host = self.local_host.clone();
        let port = self.local_port;
        tokio::spawn(async move {
            let mut channel = channel.into_stream();
            match TcpStream::connect((host.as_str(), port)).await {
                Ok(mut tcp) => {
                    if let Err(error) = tokio::io::copy_bidirectional(&mut channel, &mut tcp).await
                    {
                        tracing::warn!("remote forward connection failed: {error}");
                    }
                }
                Err(error) => tracing::warn!("remote forward local target failed: {error}"),
            }
        });
        Ok(())
    }
}

async fn run_remote(
    ssh_host: String,
    ssh_port: u16,
    username: String,
    auth_method: String,
    secret: Option<String>,
    passphrase: Option<String>,
    rule: ForwardRule,
    mut stop: oneshot::Receiver<()>,
) {
    let config = Arc::new(russh::client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(15)),
        nodelay: true,
        ..Default::default()
    });
    let mut handle = match russh::client::connect(
        config,
        (ssh_host.as_str(), ssh_port),
        RemoteHandler {
            local_host: rule.local_host.clone(),
            local_port: rule.local_port,
        },
    )
    .await
    {
        Ok(handle) => handle,
        Err(error) => {
            tracing::warn!("remote forward SSH connection failed: {error}");
            return;
        }
    };

    let auth = match auth_method.as_str() {
        "password" => {
            handle
                .authenticate_password(username.clone(), secret.unwrap_or_default())
                .await
        }
        "publicKey" => {
            let Some(path) = secret else {
                tracing::warn!("remote forward is missing private key path");
                return;
            };
            let key = match load_secret_key(&path, passphrase.as_deref()) {
                Ok(key) => key,
                Err(error) => {
                    tracing::warn!("remote forward private key load failed: {error}");
                    return;
                }
            };
            handle
                .authenticate_publickey(
                    username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
        }
        other => {
            tracing::warn!("unsupported remote forward auth method: {other}");
            return;
        }
    };
    let authenticated = match auth {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!("remote forward authentication failed: {error}");
            return;
        }
    };
    if !authenticated.success() {
        tracing::warn!("remote forward authentication rejected");
        return;
    }

    let listen_address = rule.remote_host.clone();
    let listen_port = match handle
        .tcpip_forward(listen_address.clone(), rule.remote_port as u32)
        .await
    {
        Ok(port) => port,
        Err(error) => {
            tracing::warn!("remote forward registration failed: {error}");
            return;
        }
    };
    tokio::select! {
        _ = &mut stop => {},
        _ = std::future::pending::<()>() => {},
    }
    if let Err(error) = handle
        .cancel_tcpip_forward(listen_address, listen_port)
        .await
    {
        tracing::warn!("remote forward cancellation failed: {error}");
    }
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "forward stopped", "en")
        .await;
}

// Keep these bounds visible to rustc when russh changes its ChannelStream type.
#[allow(dead_code)]
fn assert_async_stream<T: AsyncRead + AsyncWrite + Unpin + Send>() {}

#[allow(dead_code)]
fn assert_channel_stream() {
    assert_async_stream::<russh::ChannelStream<russh::client::Msg>>();
}

// ChannelMsg is imported deliberately as a compile-time reminder that the
// channel stream carries russh channel data, not raw socket bytes.
#[allow(dead_code)]
fn _channel_message_type(_: Option<ChannelMsg>) {}
