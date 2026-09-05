mod commands;
mod forward;
mod monitor;
mod preview;
mod servers;
mod sftp;
mod ssh;
mod sync;
mod tmux;
mod workspace;
mod vscode;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            app.manage(ssh::SshState::default());
            app.manage(preview::PreviewState::default());
            app.manage(monitor::MonitorState::default());
            app.manage(forward::ForwardState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_ssh_keys,
            workspace::workspace_changes,
            workspace::workspace_diff,
            vscode::vscode_open,
            ssh::ssh_connect,
            ssh::ssh_start,
            tmux::tmux_snapshot,
            tmux::tmux_action,
            tmux::tmux_copy_buffer,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            servers::servers_list,
            servers::servers_import_private_key,
            servers::servers_move,
            servers::servers_auto_group,
            servers::servers_upsert,
            servers::servers_delete,
            servers::servers_clone,
            sync::sync_test,
            sync::sync_upload,
            sync::sync_download,
            preview::open_image_preview,
            preview::take_pending_image,
            monitor::monitor_start,
            monitor::monitor_stop,
            sftp::sftp_list,
            sftp::sftp_home,
            sftp::sftp_clipboard_image,
            sftp::sftp_read_text,
            sftp::sftp_save_text,
            sftp::sftp_open_local,
            sftp::sftp_download,
            sftp::sftp_upload,
            sftp::cancel_upload,
            sftp::sftp_mkdir,
            sftp::sftp_delete,
            sftp::sftp_rename,
            forward::forward_start,
            forward::forward_stop,
            forward::forward_list,
            forward::forward_rules_list,
            forward::forward_rules_save,
            forward::forward_stop_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dssh");
}
