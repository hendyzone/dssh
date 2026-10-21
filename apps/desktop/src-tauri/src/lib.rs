mod commands;
mod local_shell;
mod collaboration;
mod taskboard;
mod quota;
mod claude;
mod ai;
mod diagnostics;
mod forward;
mod monitor;
mod preview;
mod office;
mod servers;
mod sftp;
mod sftp_tree;
mod ssh;
mod sync;
mod tmux;
mod tmux_program_status;
mod team_ai;
mod workspace;
mod vscode;

use tauri::Manager;

fn install_command_handler<R: tauri::Runtime, F>(builder: tauri::Builder<R>, dispatch: F) -> tauri::Builder<R>
where F: Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    builder.invoke_handler(move |invoke| {
        if !office::command_allowed(invoke.message.webview_ref().label(), invoke.message.command()) {
            invoke.resolver.reject("Command is not available in this window");
            return true;
        }
        dispatch(invoke)
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let _ = diagnostics::record(app.handle(), "startup", "Tauri application started", "");
            #[cfg(windows)]
            diagnostics::watch_webview_process(app.handle());
            app.manage(ssh::SshState::default());
            app.manage(local_shell::LocalState::default());
            app.manage(preview::PreviewState::default());
            app.manage(office::OfficeState::default());
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
            // Desktop menu strips clash with the themed workspace on Linux too.
            #[cfg(any(windows, target_os = "linux"))]
            for window in app.webview_windows().values() {
                window.hide_menu()?;
                #[cfg(target_os = "linux")]
                if window.label() == "main" { window.set_decorations(false)?; }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            office::window_event(window, event);
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                window.state::<local_shell::LocalState>().shutdown();
            }
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
        });
    install_command_handler(builder, tauri::generate_handler![
            office::open_office_window,
            office::office_publish_snapshot,
            office::office_request_snapshot,
            office::office_main_visibility,
            office::office_window_exists,
            local_shell::local_connect,
            local_shell::local_start,
            local_shell::local_write,
            local_shell::local_resize,
            local_shell::local_disconnect,
            team_ai::team_ai_key,
            team_ai::team_ai_models,
            team_ai::team_ai_capture,
            team_ai::team_ai_capture_saved,
            team_ai::team_ai_summarize,
            collaboration::collaboration_request,
            collaboration::collaboration_worktree,
            collaboration::collaboration_export_guide,
            taskboard::taskboard_get,
            taskboard::taskboard_open,
            quota::quota_fetch,
            claude::claude_status,
            ai::ai_status,
            ai::ai_setup,
            commands::desktop_devtools,
            commands::desktop_report_error,
            commands::desktop_restart,
            commands::list_ssh_keys,
            workspace::workspace_changes,
            workspace::workspace_diff,
            vscode::vscode_open,
            ssh::ssh_connect,
            ssh::ssh_live_connections,
            ssh::ssh_start,
            tmux::tmux_snapshot,
            tmux_program_status::tmux_program_status,
            tmux::tmux_action,
            tmux::tmux_copy_buffer,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            servers::servers_list,
            servers::servers_import_private_key,
            servers::servers_read_imported_key,
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
            sftp::clipboard_file_paths,
            sftp::sftp_clipboard_upload,
            sftp::sftp_clipboard_file,
            sftp::sftp_read_text,
            sftp::sftp_read_image,
            sftp::sftp_save_text,
            sftp::sftp_open_local,
            sftp::sftp_reveal_local,
            sftp::sftp_download,
            sftp_tree::sftp_download_tree,
            sftp_tree::sftp_local_conflicts,
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

#[cfg(test)]
mod handler_tests {
    use super::*;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    #[test]
    fn actual_handler_registration_rejects_untrusted_windows_before_dispatch() {
        let calls = Arc::new(AtomicUsize::new(0));
        let observed = calls.clone();
        let app = install_command_handler(tauri::test::mock_builder(), move |invoke| {
            observed.fetch_add(1, Ordering::SeqCst);
            invoke.resolver.resolve("business dispatcher reached");
            true
        }).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        for label in ["office", "unknown", "main"] {
            let window = tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default()).build().unwrap();
            let response = tauri::test::get_ipc_response(&window, tauri::webview::InvokeRequest {
                cmd: "ssh_connect".into(), callback: tauri::ipc::CallbackFn(0), error: tauri::ipc::CallbackFn(1),
                url: window.url().unwrap(), body: tauri::ipc::InvokeBody::Json(serde_json::json!({})),
                headers: Default::default(), invoke_key: tauri::test::INVOKE_KEY.into(),
            });
            if label == "main" {
                assert!(response.is_ok());
                assert_eq!(calls.load(Ordering::SeqCst), 1);
            } else {
                assert_eq!(response.unwrap_err(), serde_json::json!("Command is not available in this window"));
                assert_eq!(calls.load(Ordering::SeqCst), 0);
            }
        }
        // Structural supplement only: the native run path must use this tested installer.
        let production = include_str!("lib.rs").split("#[cfg(test)]").next().unwrap();
        assert!(production.contains("install_command_handler(builder, tauri::generate_handler!["));
        assert_eq!(production.matches(".invoke_handler(").count(), 1);
    }
}
