//! 自动更新：Linux deb/rpm 只提示链接，AppImage 与 Win/mac 走 updater 插件。

#[tauri::command]
pub fn updater_install_mode() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("APPIMAGE").is_none() {
            return "link_only";
        }
    }
    "auto_install"
}
