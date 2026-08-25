//! SSH 会话管理（russh）
//!
//! 数据流：
//!   远程主机 ←→ russh channel ←→ Tauri event `ssh://{session_id}/data` ←→ 前端 ghostty-web
//!
//! 当前为 M1 骨架：接口定义与生命周期管理已就位，认证与通道读取循环待填充。

use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

/// 服务器连接参数（与前端 ServerEntry 对应）
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 认证方式：password / publicKey / agent
    pub auth_method: String,
    /// 密码或私钥路径（passphrase 从 keyring 取）
    pub secret: Option<String>,
}

pub struct Session {
    #[allow(dead_code)]
    id: String,
    // TODO(M1): russh::client::Handle<SshHandler> 与 channel 写端
}

#[derive(Default)]
pub struct SshState {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("not implemented yet")]
    Todo,
}

impl serde::Serialize for SshError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// 建立 SSH 会话，返回 session_id；输出通过事件推送
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, SshState>,
    params: ConnectParams,
) -> Result<String, SshError> {
    let session_id = uuid_v4();
    tracing::info!(
        "ssh_connect {}@{}:{} ({})",
        params.username,
        params.host,
        params.port,
        params.auth_method
    );

    // TODO(M1): russh::client::connect → open channel → request pty/shell
    // 读取循环中 app.emit_all(&format!("ssh://{session_id}/data"), chunk)

    state
        .sessions
        .lock()
        .await
        .insert(session_id.clone(), Session { id: session_id.clone() });

    // 骨架阶段：回显一行提示，验证事件通道
    let _ = app.emit(
        &format!("ssh://{session_id}/data"),
        format!("dssh skeleton: connected stub for {}@{}:{}\r\n", params.username, params.host, params.port),
    );

    Ok(session_id)
}

/// 前端终端输入 → SSH channel
#[tauri::command]
pub async fn ssh_write(state: State<'_, SshState>, session_id: String, data: String) -> Result<(), SshError> {
    if !state.sessions.lock().await.contains_key(&session_id) {
        return Err(SshError::NotFound(session_id));
    }
    // TODO(M1): channel.write(data)
    let _ = data;
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
    if !state.sessions.lock().await.contains_key(&session_id) {
        return Err(SshError::NotFound(session_id));
    }
    // TODO(M1): channel.window_change(cols, rows)
    let _ = (cols, rows);
    Ok(())
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, SshState>, session_id: String) -> Result<(), SshError> {
    state.sessions.lock().await.remove(&session_id);
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
