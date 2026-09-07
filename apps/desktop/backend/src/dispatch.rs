//! Explicit IPC command allowlist. Keep electron/commands.json in sync.
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use crate::runtime::Context;
fn argument<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|error| format!("Invalid argument {name}: {error}"))
}
fn encode<T: Serialize, E: std::fmt::Display>(result: Result<T, E>) -> Result<Value, String> {
    result.map_err(|error| error.to_string()).and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string()))
}
pub async fn dispatch(ctx: &Context, command: &str, args: Value) -> Result<Value, String> {
    match command {
        "list_ssh_keys" => encode(crate::commands::list_ssh_keys()),
        "forward_start" => encode(crate::forward::forward_start(&ctx.forward, &ctx.ssh, argument(&args, "sessionId")?, argument(&args, "rule")?, argument(&args, "ruleId")?).await),
        "forward_rules_list" => encode(crate::forward::forward_rules_list(ctx.app.clone(), &ctx.ssh, argument(&args, "sessionId")?).await),
        "forward_rules_save" => encode(crate::forward::forward_rules_save(ctx.app.clone(), &ctx.ssh, argument(&args, "sessionId")?, argument(&args, "rules")?).await),
        "forward_stop" => encode(crate::forward::forward_stop(&ctx.forward, argument(&args, "ruleId")?).await),
        "forward_list" => encode(crate::forward::forward_list(&ctx.forward, argument(&args, "sessionId")?).await),
        "forward_stop_session" => encode(crate::forward::forward_stop_session(&ctx.forward, argument(&args, "sessionId")?).await),
        "monitor_start" => encode(crate::monitor::monitor_start(ctx.app.clone(), &ctx.ssh, &ctx.monitor, argument(&args, "sessionId")?, argument(&args, "ownerId")?).await),
        "monitor_stop" => encode(crate::monitor::monitor_stop(&ctx.monitor, argument(&args, "sessionId")?, argument(&args, "ownerId")?).await),
        "servers_import_private_key" => encode(crate::servers::servers_import_private_key(ctx.app.clone(), argument(&args, "content")?, argument(&args, "passphrase")?).await),
        "servers_list" => encode(crate::servers::servers_list(ctx.app.clone()).await),
        "servers_auto_group" => encode(crate::servers::servers_auto_group(ctx.app.clone()).await),
        "servers_move" => encode(crate::servers::servers_move(ctx.app.clone(), argument(&args, "id")?, argument(&args, "group")?).await),
        "servers_upsert" => encode(crate::servers::servers_upsert(ctx.app.clone(), argument(&args, "record")?, argument(&args, "password")?, argument(&args, "passphrase")?).await),
        "servers_delete" => encode(crate::servers::servers_delete(ctx.app.clone(), argument(&args, "id")?).await),
        "servers_clone" => encode(crate::servers::servers_clone(ctx.app.clone(), argument(&args, "id")?).await),
        "sftp_list" => encode(crate::sftp::sftp_list(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "path")?).await),
        "sftp_download" => encode(crate::sftp::sftp_download(ctx.app.clone(), &ctx.ssh, argument(&args, "sessionId")?, argument(&args, "remotePath")?, argument(&args, "transferId")?).await),
        "sftp_upload" => encode(crate::sftp::sftp_upload(ctx.app.clone(), &ctx.ssh, argument(&args, "sessionId")?, argument(&args, "remotePath")?, argument(&args, "localPath")?, argument(&args, "transferId")?).await),
        "cancel_upload" => encode(crate::sftp::cancel_upload(argument(&args, "transferId")?).await),
        "sftp_mkdir" => encode(crate::sftp::sftp_mkdir(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "path")?).await),
        "sftp_delete" => encode(crate::sftp::sftp_delete(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "path")?, argument(&args, "isDir")?).await),
        "sftp_rename" => encode(crate::sftp::sftp_rename(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "oldPath")?, argument(&args, "newPath")?).await),
        "sftp_home" => encode(crate::sftp::sftp_home(&ctx.ssh, argument(&args, "sessionId")?).await),
        "sftp_clipboard_image" => encode(crate::sftp::sftp_clipboard_image(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "data")?).await),
        "sftp_read_text" => encode(crate::sftp::sftp_read_text(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "path")?).await),
        "sftp_save_text" => encode(crate::sftp::sftp_save_text(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "path")?, argument(&args, "original")?, argument(&args, "content")?).await),
        "sftp_open_local" => encode(crate::sftp::sftp_open_local(argument(&args, "path")?, argument(&args, "application")?).await),
        "ssh_connect" => encode(crate::ssh::ssh_connect(ctx.app.clone(), &ctx.ssh, argument(&args, "params")?).await),
        "ssh_start" => encode(crate::ssh::ssh_start(&ctx.ssh, argument(&args, "sessionId")?).await),
        "ssh_write" => encode(crate::ssh::ssh_write(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "data")?).await),
        "ssh_resize" => encode(crate::ssh::ssh_resize(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "cols")?, argument(&args, "rows")?).await),
        "ssh_disconnect" => encode(crate::ssh::ssh_disconnect(&ctx.ssh, argument(&args, "sessionId")?).await),
        "sync_test" => encode(crate::sync::sync_test(argument(&args, "pat")?, argument(&args, "repository")?).await),
        "sync_upload" => encode(crate::sync::sync_upload(ctx.app.clone(), argument(&args, "pat")?, argument(&args, "repository")?, argument(&args, "password")?, argument(&args, "uiState")?).await),
        "sync_download" => encode(crate::sync::sync_download(ctx.app.clone(), argument(&args, "pat")?, argument(&args, "repository")?, argument(&args, "password")?).await),
        "tmux_snapshot" => encode(crate::tmux::tmux_snapshot(&ctx.ssh, argument(&args, "sessionId")?).await),
        "tmux_action" => encode(crate::tmux::tmux_action(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "request")?).await),
        "tmux_copy_buffer" => encode(crate::tmux::tmux_copy_buffer(&ctx.ssh, argument(&args, "sessionId")?).await),
        "vscode_open" => encode(crate::vscode::vscode_open(ctx.app.clone(), argument(&args, "serverId")?, argument(&args, "path")?).await),
        "workspace_changes" => encode(crate::workspace::workspace_changes(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "path")?).await),
        "workspace_diff" => encode(crate::workspace::workspace_diff(&ctx.ssh, argument(&args, "sessionId")?, argument(&args, "root")?, argument(&args, "path")?, argument(&args, "kind")?).await),
        _ => Err(format!("Unknown command: {command}")),
    }
}
