use crate::{
    ssh::SshState,
    tmux::{execute_with_timeout, quote},
};
use base64::Engine;
use tauri::State;

async fn request(
    ssh: &SshState,
    session_id: &str,
    args: Vec<String>,
) -> Result<serde_json::Value, String> {
    let handle = ssh.get_handle(session_id).await.ok_or("SSH 已断开")?;
    let source = base64::engine::general_purpose::STANDARD.encode(include_str!("ai_status.py"));
    let argv = serde_json::to_string(&args).map_err(|e| e.to_string())?;
    let bootstrap = format!("import base64,os,runpy,tempfile,sys,json; os.umask(0o077); f=tempfile.NamedTemporaryFile(suffix='.py',delete=False); f.write(base64.b64decode('{source}')); f.close(); sys.argv=[f.name]+json.loads({argv:?});\ntry: runpy.run_path(f.name,run_name='__main__')\nfinally: os.unlink(f.name)");
    let output = execute_with_timeout(
        &handle,
        &format!("python3 -c {}", quote(&bootstrap)),
        std::time::Duration::from_secs(12),
    )
    .await?;
    serde_json::from_str(&output).map_err(|e| format!("AI 状态响应格式错误：{e}"))
}

#[tauri::command]
pub async fn ai_status(
    ssh: State<'_, SshState>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    request(&ssh, &session_id, vec!["status".into()]).await
}

#[tauri::command]
pub async fn ai_setup(
    ssh: State<'_, SshState>,
    session_id: String,
    provider: String,
    remove: bool,
) -> Result<serde_json::Value, String> {
    if !["claude", "codex", "pi"].contains(&provider.as_str()) {
        return Err("不支持的 AI 工具".into());
    }
    request(
        &ssh,
        &session_id,
        vec![
            if remove { "remove" } else { "install" }.into(),
            provider,
            base64::engine::general_purpose::STANDARD.encode(include_str!("ai_pi_extension.ts")),
        ],
    )
    .await
}
