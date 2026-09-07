use crate::{ssh::SshState, tmux::{execute_with_timeout, quote}};
use base64::Engine;
use tauri::State;

#[tauri::command]
pub async fn claude_status(ssh: State<'_, SshState>, session_id: String) -> Result<serde_json::Value, String> {
    let handle = ssh.get_handle(&session_id).await.ok_or("SSH 已断开")?;
    let source = base64::engine::general_purpose::STANDARD.encode(include_str!("claude_status.py"));
    // A temporary helper avoids changing shell profiles or global Claude settings.
    let bootstrap = format!("import base64,os,runpy,tempfile; os.umask(0o077); f=tempfile.NamedTemporaryFile(suffix='.py',delete=False); f.write(base64.b64decode('{}')); f.close();\ntry: runpy.run_path(f.name,run_name='__main__')\nfinally: os.unlink(f.name)", source);
    let command = format!("export PATH=\"$HOME/.local/bin:$PATH\"; python3 -c {}", quote(&bootstrap));
    let output = execute_with_timeout(&handle, &command, std::time::Duration::from_secs(12)).await?;
    serde_json::from_str(&output).map_err(|e| format!("Claude 状态响应格式错误：{e}"))
}
