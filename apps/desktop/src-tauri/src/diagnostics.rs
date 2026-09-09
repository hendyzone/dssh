use std::{fs, io::Write, path::Path, sync::Mutex};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

static LOG_LOCK: Mutex<()> = Mutex::new(());
const LIMIT: u64 = 1024 * 1024;

/// JS error handlers cannot run after a native WebView2 renderer crash.
#[cfg(windows)]
pub fn watch_webview_process(app: &tauri::AppHandle) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::*,
        ProcessFailedEventHandler,
    };
    use windows_core::Interface;
    let Some(window) = app.get_webview_window("main") else { return };
    let browser_args = app.config().app.windows.iter()
        .find(|window| window.label == "main")
        .and_then(|window| window.additional_browser_args.as_deref())
        .unwrap_or("default");
    let _ = record(app, "webview_configuration", browser_args, "");
    let handle = app.clone();
    let result = window.with_webview(move |webview| {
        let event_app = handle.clone();
        let registration = unsafe {
            webview.controller().CoreWebView2().and_then(|view| {
                let mut token = 0;
                view.add_ProcessFailed(
                    &ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        let mut details = String::from("WebView2 process failed");
                        if let Some(args) = args {
                            let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                            if args.ProcessFailedKind(&mut kind).is_ok() {
                                details.push_str(&format!("; kind={}", kind.0));
                            }
                            if let Ok(extra) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                                let mut exit_code = 0;
                                if extra.Reason(&mut reason).is_ok() {
                                    details.push_str(&format!("; reason={}", reason.0));
                                }
                                if extra.ExitCode(&mut exit_code).is_ok() {
                                    details.push_str(&format!("; exit_code=0x{:08X}", exit_code as u32));
                                }
                            }
                        }
                        let _ = record(&event_app, "webview_process_failed", &details, "");
                        Ok(())
                    })),
                    &mut token,
                )
            })
        };
        if let Err(error) = registration {
            let _ = record(&handle, "webview_monitor_error", &error.to_string(), "");
        }
    });
    if let Err(error) = result {
        let _ = record(app, "webview_monitor_error", &error.to_string(), "");
    }
}

pub fn record(app: &tauri::AppHandle, kind: &str, message: &str, stack: &str) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("desktop.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() >= LIMIT) {
        let previous = dir.join("desktop.previous.log");
        if previous.exists() { fs::remove_file(&previous).map_err(|e| e.to_string())?; }
        fs::rename(&path, previous).map_err(|e| e.to_string())?;
    }
    let entry = serde_json::json!({
        "time": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis(),
        "version": env!("CARGO_PKG_VERSION"), "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH, "kind": kind,
        "message": message.chars().take(4000).collect::<String>(),
        "stack": stack.chars().take(8000).collect::<String>(),
    });
    let mut file = fs::OpenOptions::new().create(true).append(true).open(path).map_err(|e| e.to_string())?;
    writeln!(file, "{entry}").map_err(|e| e.to_string())
}

fn export(app: &tauri::AppHandle, destination: &Path) -> Result<(), String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut contents = String::from("dssh diagnostics (timestamps: Unix milliseconds)\n");
    for name in ["desktop.previous.log", "desktop.log"] {
        match fs::read_to_string(dir.join(name)) {
            Ok(log) => { contents.push_str(&format!("\n--- {name} ---\n")); contents.push_str(&log); }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    fs::write(destination, contents).map_err(|e| e.to_string())
}

pub fn export_dialog(app: &tauri::AppHandle) {
    let handle = app.clone();
    app.dialog().file().set_file_name("dssh-diagnostics.log").save_file(move |file| {
        let Some(file) = file else { return };
        let result = file.into_path().map_err(|e| e.to_string()).and_then(|path| export(&handle, &path));
        let message = match result { Ok(()) => "诊断日志已导出，可用于问题排查。".to_owned(), Err(error) => format!("导出失败：{error}") };
        handle.dialog().message(message).title("导出诊断日志").show(|_| {});
    });
}
