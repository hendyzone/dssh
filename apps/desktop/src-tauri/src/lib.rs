mod preview;
mod ssh;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(ssh::SshState::default());
            app.manage(preview::PreviewState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            preview::open_image_preview,
            preview::take_pending_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running dssh");
}
