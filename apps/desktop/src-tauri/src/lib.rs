mod commands;
mod collaboration;
mod claude;
mod diagnostics;
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
            let _ = diagnostics::record(app.handle(), "startup", "Tauri application started", "");
            app.manage(ssh::SshState::default());
            app.manage(preview::PreviewState::default());
            app.manage(monitor::MonitorState::default());
            app.manage(forward::ForwardState::default());
            use tauri::menu::{Menu, MenuItem, Submenu};
            let devtools = MenuItem::with_id(app, "devtools", "开发者工具", true, Some("F12"))?;
            let logs = MenuItem::with_id(app, "diagnostics", "诊断日志位置", true, None::<&str>)?;
            let export = MenuItem::with_id(app, "export-diagnostics", "导出诊断日志", true, None::<&str>)?;
            let view = Submenu::with_items(app, "视图", true, &[&devtools, &export, &logs])?;
            // Keep native edit/application menus (especially macOS copy/paste).
            let menu = Menu::default(app.handle())?;
            menu.append(&view)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(window) = app.get_webview_window("main") {
                match event.id().as_ref() {
                    "devtools" => window.open_devtools(),
                    "export-diagnostics" => diagnostics::export_dialog(app),
                    "diagnostics" => {
                        use tauri_plugin_dialog::DialogExt;
                        if let Ok(path) = app.path().app_log_dir() {
                            app.dialog().message(format!("界面异常日志：{}", path.join("desktop.log").display()))
                                .title("诊断日志位置").show(|_| {});
                        }
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            collaboration::collaboration_request,
            claude::claude_status,
            commands::desktop_devtools,
            commands::desktop_report_error,
            commands::desktop_restart,
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
