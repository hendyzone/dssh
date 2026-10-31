//! A display-only office window. Only the main window supplies room data.
use serde::{Deserialize, Serialize};
use std::{fs, sync::Mutex};
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

const LABEL: &str = "office";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    epoch: String,
    sequence: u64,
    snapshot: serde_json::Value,
}
#[derive(Serialize)]
pub struct Initial {
    snapshot: Option<Envelope>,
    visible: bool,
}
#[derive(Default)]
pub struct OfficeState {
    opening: tokio::sync::Mutex<()>,
    latest: Mutex<Option<Envelope>>,
    geometry: Mutex<Option<Geometry>>,
}

// Event routing is not a confidentiality boundary: office and preview-* windows
// have event-listen permissions, so their Any listeners can receive emit_to(main).
// These windows load trusted local content, not remote pages; office snapshots
// deliberately omit backend session IDs.

/// Core/plugin commands are separately restricted by window capabilities.
/// App commands have no ACL manifest, so explicitly isolate these routes.
pub fn command_allowed(label: &str, command: &str) -> bool {
    match label {
        "main" => true,
        "office" => matches!(command, "office_request_snapshot" | "desktop_report_error"),
        label if label.starts_with("preview-") => {
            matches!(command, "take_pending_image" | "desktop_report_error")
        }
        label if label.starts_with("detached-") => matches!(command,
            "tab_snapshot" | "tab_connect" | "tab_ready" | "tab_return" | "tab_failed" | "tab_drag_end" |
            "ssh_start" | "ssh_write" | "ssh_resize" | "ssh_disconnect" |
            "local_start" | "local_write" | "local_resize" | "local_disconnect" |
            "sftp_read_text" | "sftp_read_image" | "desktop_report_error"),
        _ => false,
    }
}
fn caller<R: tauri::Runtime>(window: &WebviewWindow<R>, expected: &str) -> Result<(), String> {
    if window.label() == expected {
        Ok(())
    } else {
        Err("Window is not permitted to perform this operation".into())
    }
}
fn visible(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

#[tauri::command]
pub async fn office_publish_snapshot<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, OfficeState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    caller(&window, "main")?;
    if app.get_webview_window(LABEL).is_none() {
        return Ok(());
    }
    if snapshot.get("version").and_then(|v| v.as_u64()) != Some(1)
        || !snapshot.get("projects").is_some_and(|v| v.is_array())
    {
        return Err("Invalid office snapshot".into());
    }
    if serde_json::to_vec(&snapshot)
        .map_err(|e| e.to_string())?
        .len()
        > 2 * 1024 * 1024
    {
        return Err("Office snapshot is too large".into());
    }
    // Serialize cache updates; receivers ignore any older emission arriving later.
    let mut latest = state.latest.lock().map_err(|e| e.to_string())?;
    let envelope = Envelope {
        epoch: latest.as_ref().map(|e| e.epoch.clone()).unwrap_or_else(|| {
            format!(
                "{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            )
        }),
        sequence: latest.as_ref().map(|e| e.sequence + 1).unwrap_or(1),
        snapshot,
    };
    if latest
        .as_ref()
        .is_some_and(|old| old.snapshot == envelope.snapshot)
    {
        return Ok(());
    }
    *latest = Some(envelope.clone());
    drop(latest);
    app.emit_to(
        EventTarget::webview_window(LABEL),
        "office:snapshot",
        &envelope,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn office_request_snapshot(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, OfficeState>,
) -> Result<Initial, String> {
    caller(&window, LABEL)?;
    let snapshot = state.latest.lock().map_err(|e| e.to_string())?.clone();
    app.emit_to(EventTarget::webview_window("main"), "office:request", ())
        .map_err(|e| e.to_string())?;
    Ok(Initial {
        snapshot,
        visible: visible(&window),
    })
}

#[tauri::command]
pub fn office_main_visibility(window: WebviewWindow) -> Result<bool, String> {
    caller(&window, "main")?;
    Ok(visible(&window))
}

#[tauri::command]
pub fn office_window_exists(window: WebviewWindow, app: AppHandle) -> Result<bool, String> {
    caller(&window, "main")?;
    Ok(app.get_webview_window(LABEL).is_some())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
struct Rect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Display {
    name: Option<String>,
    area: Rect,
    scale: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Geometry {
    version: u8,
    outer: Rect,
    inner_width: u32,
    inner_height: u32,
    display: Display,
}
fn display(m: tauri::Monitor) -> Display {
    let a = m.work_area();
    Display {
        name: m.name().cloned(),
        area: Rect {
            x: a.position.x,
            y: a.position.y,
            width: a.size.width,
            height: a.size.height,
        },
        scale: m.scale_factor(),
    }
}
fn valid(g: &Geometry) -> bool {
    g.version == 1
        && g.inner_width > 0
        && g.inner_height > 0
        && g.outer.width >= g.inner_width
        && g.outer.height >= g.inner_height
        && g.outer.width <= 32768
        && g.outer.height <= 32768
        && g.display.scale.is_finite()
        && g.display.scale > 0.0
        && g.display.scale < 16.0
}
/// Match the saved display, then fall back to the primary display. Keep the full frame visible.
fn restore(g: &Geometry, monitors: &[Display], primary: Option<&Display>) -> Option<Geometry> {
    if !valid(g) {
        return None;
    }
    let target = monitors
        .iter()
        .find(|m| m.name == g.display.name && m.area == g.display.area)
        .or_else(|| {
            let mut matches = monitors
                .iter()
                .filter(|m| m.name.is_some() && m.name == g.display.name);
            let first = matches.next();
            if matches.next().is_none() {
                first
            } else {
                None
            }
        })
        .or(primary)
        .or_else(|| monitors.first())?;
    if target.area.width == 0
        || target.area.height == 0
        || !target.scale.is_finite()
        || target.scale <= 0.0
    {
        return None;
    }
    let ratio = target.scale / g.display.scale;
    let outer_width = ((g.outer.width as f64 * ratio).round() as u32).clamp(1, target.area.width);
    let outer_height =
        ((g.outer.height as f64 * ratio).round() as u32).clamp(1, target.area.height);
    let frame_w = ((g.outer.width - g.inner_width) as f64 * ratio).round() as u32;
    let frame_h = ((g.outer.height - g.inner_height) as f64 * ratio).round() as u32;
    let same_display = target.name.is_some()
        && target.name == g.display.name
        && monitors.iter().any(|m| m.name == g.display.name);
    let desired_x = if same_display {
        target.area.x as i64
            + ((g.outer.x as i64 - g.display.area.x as i64) as f64 * ratio).round() as i64
    } else {
        target.area.x as i64 + (target.area.width - outer_width) as i64 / 2
    };
    let desired_y = if same_display {
        target.area.y as i64
            + ((g.outer.y as i64 - g.display.area.y as i64) as f64 * ratio).round() as i64
    } else {
        target.area.y as i64 + (target.area.height - outer_height) as i64 / 2
    };
    Some(Geometry {
        version: 1,
        outer: Rect {
            x: desired_x.clamp(
                target.area.x as i64,
                target.area.x as i64 + (target.area.width - outer_width) as i64,
            ) as i32,
            y: desired_y.clamp(
                target.area.y as i64,
                target.area.y as i64 + (target.area.height - outer_height) as i64,
            ) as i32,
            width: outer_width,
            height: outer_height,
        },
        inner_width: outer_width.saturating_sub(frame_w).max(1),
        inner_height: outer_height.saturating_sub(frame_h).max(1),
        display: target.clone(),
    })
}
fn path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|p| p.join("office-window.json"))
}
fn load(app: &AppHandle) -> Option<Geometry> {
    let g: Geometry = serde_json::from_slice(&fs::read(path(app)?).ok()?).ok()?;
    valid(&g).then_some(g)
}
fn atomic_write(path: &std::path::Path, data: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temporary = path.with_extension("json.tmp");
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}
fn persist(app: &AppHandle) {
    let Some(path) = path(app) else {
        return;
    };
    let state = app.state::<OfficeState>();
    let Ok(geometry) = state.geometry.lock() else {
        return;
    };
    let Some(geometry) = geometry.as_ref() else {
        return;
    };
    let Ok(data) = serde_json::to_vec(geometry) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(error) = atomic_write(&path, &data) {
        eprintln!("Office geometry save failed: {error}");
    }
}
fn capture(window: &WebviewWindow) {
    if window.is_maximized().unwrap_or(true) || window.is_minimized().unwrap_or(true) {
        return;
    }
    let (Ok(pos), Ok(outer), Ok(inner), Ok(Some(monitor))) = (
        window.outer_position(),
        window.outer_size(),
        window.inner_size(),
        window.current_monitor(),
    ) else {
        return;
    };
    let geometry = Geometry {
        version: 1,
        outer: Rect {
            x: pos.x,
            y: pos.y,
            width: outer.width,
            height: outer.height,
        },
        inner_width: inner.width,
        inner_height: inner.height,
        display: display(monitor),
    };
    if valid(&geometry) {
        if let Ok(mut saved) = window.state::<OfficeState>().geometry.lock() {
            *saved = Some(geometry);
        }
    }
}
fn ensure_visible(window: &WebviewWindow) {
    let state = window.state::<OfficeState>();
    let saved = state.geometry.lock().ok().and_then(|g| g.clone());
    let Some(saved) = saved else {
        return;
    };
    let monitors: Vec<_> = window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(display)
        .collect();
    let primary = window.primary_monitor().ok().flatten().map(display);
    let Some(next) = restore(&saved, &monitors, primary.as_ref()) else {
        return;
    };
    if !window.is_maximized().unwrap_or(false) {
        if window.inner_size().ok() != Some(PhysicalSize::new(next.inner_width, next.inner_height))
        {
            let _ = window.set_size(PhysicalSize::new(next.inner_width, next.inner_height));
        }
        if window.outer_position().ok() != Some(PhysicalPosition::new(next.outer.x, next.outer.y)) {
            let _ = window.set_position(PhysicalPosition::new(next.outer.x, next.outer.y));
        }
    }
    if let Ok(mut saved) = state.geometry.lock() {
        *saved = Some(next);
    };
}

// Monitor handle conversion can call platform display APIs even after a dispatched getter.
// Keep monitor reads on the UI thread; window construction itself stays off that thread.
async fn on_main(
    app: &AppHandle,
    action: impl FnOnce() -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .map_err(|e| e.to_string())?;
    receiver.await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_office_window(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, OfficeState>,
) -> Result<(), String> {
    caller(&window, "main")?;
    // Serialize check/build/focus, including the main-thread restoration step.
    let _opening = state.opening.lock().await;
    if let Some(existing) = app.get_webview_window(LABEL) {
        let handle = app.clone();
        return on_main(&app, move || {
            ensure_visible(&existing);
            existing.show().map_err(|e| e.to_string())?;
            existing.unminimize().map_err(|e| e.to_string())?;
            ensure_visible(&existing);
            existing.set_focus().map_err(|e| e.to_string())?;
            let _ = handle.emit_to(EventTarget::webview_window("main"), "office:presence", true);
            let _ = handle.emit_to(
                EventTarget::webview_window(LABEL),
                "office:visibility",
                true,
            );
            Ok(())
        })
        .await;
    }
    *state.geometry.lock().map_err(|e| e.to_string())? = load(&app);
    let builder =
        WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#/office".into()))
            .title("dssh · 公司办公室")
            .inner_size(960.0, 640.0)
            .resizable(true)
            .visible(false);
    #[cfg(windows)]
    let builder = if let Some(args) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.as_deref())
    {
        builder.additional_browser_args(args)
    } else {
        builder
    };
    let office = builder.build().map_err(|e| e.to_string())?;
    on_main(&app, move || {
        ensure_visible(&office);
        let has_geometry = office
            .state::<OfficeState>()
            .geometry
            .lock()
            .map_err(|e| e.to_string())?
            .is_some();
        if !has_geometry {
            let _ = office.center();
        }
        office.show().map_err(|e| e.to_string())?;
        office.set_focus().map_err(|e| e.to_string())?;
        capture(&office);
        let _ = office.app_handle().emit_to(
            EventTarget::webview_window("main"),
            "office:presence",
            true,
        );
        Ok(())
    })
    .await
}

pub fn closes_office(label: &str, destroyed: bool) -> bool {
    label == "main" && destroyed
}
pub fn window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    if closes_office(window.label(), matches!(event, WindowEvent::Destroyed)) {
        persist(app);
        if let Some(office) = app.get_webview_window(LABEL) {
            let _ = office.destroy();
        }
        return;
    }
    if window.label() == "main"
        && matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_))
    {
        if let Some(main) = app.get_webview_window("main") {
            let _ = app.emit_to(
                EventTarget::webview_window("main"),
                "office:main-visibility",
                visible(&main),
            );
        }
    }
    if window.label() != LABEL {
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        let _ = app.emit_to(
            EventTarget::webview_window("main"),
            "office:presence",
            false,
        );
    }
    if matches!(
        event,
        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
    ) {
        persist(app);
    }
    if let Some(office) = app.get_webview_window(LABEL) {
        if matches!(event, WindowEvent::ScaleFactorChanged { .. }) {
            ensure_visible(&office);
        }
        if matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
        ) {
            capture(&office);
        }
        if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
            let shown = visible(&office);
            let _ = app.emit_to(
                EventTarget::webview_window(LABEL),
                "office:visibility",
                shown,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn actual_publish_command_checks_caller_and_advances_sequence() {
        let app = tauri::test::mock_builder()
            .manage(OfficeState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let office = WebviewWindowBuilder::new(&app, "office", WebviewUrl::default())
            .build()
            .unwrap();
        let first = serde_json::json!({"version":1,"projects":[],"themeId":"dark"});
        let second = serde_json::json!({"version":1,"projects":[],"themeId":"light"});
        let denied =
            office_publish_snapshot(office, app.handle().clone(), app.state(), first.clone()).await;
        assert_eq!(
            denied,
            Err("Window is not permitted to perform this operation".into())
        );
        assert!(app.state::<OfficeState>().latest.lock().unwrap().is_none());
        office_publish_snapshot(main.clone(), app.handle().clone(), app.state(), first)
            .await
            .unwrap();
        let epoch = app
            .state::<OfficeState>()
            .latest
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .epoch
            .clone();
        assert_eq!(
            app.state::<OfficeState>()
                .latest
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .sequence,
            1
        );
        office_publish_snapshot(
            main.clone(),
            app.handle().clone(),
            app.state(),
            second.clone(),
        )
        .await
        .unwrap();
        office_publish_snapshot(main, app.handle().clone(), app.state(), second.clone())
            .await
            .unwrap();
        let state = app.state::<OfficeState>();
        let cache = state.latest.lock().unwrap();
        let envelope = cache.as_ref().unwrap();
        assert_eq!(envelope.sequence, 2);
        assert_eq!(envelope.epoch, epoch);
        assert_eq!(envelope.snapshot, second);
    }
    #[tokio::test]
    async fn absent_office_publish_leaves_cache_and_events_untouched() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .manage(OfficeState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let events = Arc::new(AtomicUsize::new(0));
        let seen = events.clone();
        app.listen("office:snapshot", move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        office_publish_snapshot(
            main,
            app.handle().clone(),
            app.state(),
            serde_json::json!({"version":1,"projects":[]}),
        )
        .await
        .unwrap();
        assert!(app.state::<OfficeState>().latest.lock().unwrap().is_none());
        assert_eq!(events.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn office_capability_contains_only_events_and_fullscreen_permissions() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/office.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["office"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!([
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "core:window:allow-is-fullscreen",
                "core:window:allow-set-fullscreen"
            ])
        );
    }
    fn screen(name: &str, x: i32, width: u32, scale: f64) -> Display {
        Display {
            name: Some(name.into()),
            area: Rect {
                x,
                y: 0,
                width,
                height: 1000,
            },
            scale,
        }
    }
    fn geometry() -> Geometry {
        Geometry {
            version: 1,
            outer: Rect {
                x: -1800,
                y: 100,
                width: 800,
                height: 600,
            },
            inner_width: 780,
            inner_height: 560,
            display: screen("secondary", -1920, 1920, 1.0),
        }
    }
    #[test]
    fn office_commands_cannot_access_ssh_or_collaboration() {
        assert!(command_allowed("office", "office_request_snapshot"));
        assert!(command_allowed("office", "desktop_report_error"));
        for command in [
            "ssh_connect",
            "ssh_write",
            "collaboration_request",
            "servers_list",
            "office_publish_snapshot",
            "open_office_window",
            "take_pending_image",
        ] {
            assert!(!command_allowed("office", command), "{command}");
        }
        assert!(command_allowed("main", "ssh_connect"));
    }
    #[test]
    fn detached_windows_allow_only_reconnect_and_preview_commands() {
        for label in ["detached-123", "detached-a0b1c2"] {
            for command in [
                "tab_snapshot", "tab_connect", "tab_ready", "tab_return", "tab_failed",
                "tab_drag_end", "ssh_start", "ssh_write", "ssh_resize", "ssh_disconnect",
                "local_start", "local_write", "local_resize", "local_disconnect",
                "sftp_read_text", "sftp_read_image", "desktop_report_error",
            ] {
                assert!(command_allowed(label, command), "{label} must allow {command}");
            }
            for command in [
                "servers_upsert", "servers_list", "team_service_configure", "ssh_connect",
                "local_connect", "sftp_save_text", "collaboration_request", "tab_open",
                "tab_quit", "tab_main_mount", "tab_drop_zone", "tab_restore_preview",
                "office_publish_snapshot", "updater_install_mode", "plugin:updater|check",
                "plugin:updater|download", "plugin:updater|install",
                "plugin:updater|download_and_install", "unknown_command",
            ] {
                assert!(!command_allowed(label, command), "{label} must deny {command}");
            }
        }
    }
    #[test]
    fn unknown_windows_and_preview_cannot_call_terminal_commands() {
        for label in ["unknown", "preview-123", "office"] {
            assert!(!command_allowed(label, "ssh_connect"));
            assert!(!command_allowed(label, "collaboration_request"));
        }
        assert!(command_allowed("preview-123", "take_pending_image"));
        assert!(command_allowed("preview-123", "desktop_report_error"));
        assert!(!command_allowed("unknown", "office_request_snapshot"));
    }
    #[test]
    fn unnamed_displays_use_centered_fallback_instead_of_saved_offset() {
        let mut g = geometry();
        g.display.name = None;
        let mut target = screen("target", 0, 1200, 1.0);
        target.name = None;
        let result = restore(&g, &[target.clone()], Some(&target)).unwrap();
        assert_eq!(result.outer.x, 200);
    }
    #[test]
    fn geometry_file_is_replaced_and_temporary_file_is_removed() {
        let dir = std::env::temp_dir().join(format!("dssh-office-write-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("geometry.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert!(!path.with_extension("json.tmp").exists());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn main_destroyed_only_closes_office() {
        assert!(closes_office("main", true));
        assert!(!closes_office("main", false));
        assert!(!closes_office("office", true));
    }
    #[test]
    fn restores_negative_secondary_coordinates() {
        let g = geometry();
        let result = restore(&g, &[g.display.clone()], None).unwrap();
        assert_eq!(result.outer, g.outer);
    }
    #[test]
    fn removed_display_returns_to_primary() {
        let primary = screen("primary", 0, 1200, 1.0);
        let result = restore(&geometry(), &[primary.clone()], Some(&primary)).unwrap();
        assert_eq!(result.outer.x, 200);
        assert_eq!(result.display.name.as_deref(), Some("primary"));
    }
    #[test]
    fn changed_dpi_preserves_logical_size_and_clamps() {
        let mut monitor = geometry().display;
        monitor.scale = 2.0;
        let result = restore(&geometry(), &[monitor], None).unwrap();
        assert_eq!(result.outer.width, 1600);
        assert_eq!(result.outer.height, 1000);
        assert_eq!(result.inner_width, 1560);
        assert_eq!(result.outer.y, 0);
    }
    #[test]
    fn tiny_screen_overrides_size_and_offscreen_position() {
        let tiny = screen("primary", 0, 320, 1.0);
        let result = restore(&geometry(), &[tiny], None).unwrap();
        assert_eq!(result.outer.width, 320);
        assert_eq!(result.outer.x, 0);
    }
    #[test]
    fn invalid_geometry_or_absent_monitors_never_restores() {
        let mut g = geometry();
        g.display.scale = f64::NAN;
        assert!(restore(&g, &[screen("primary", 0, 1920, 1.0)], None).is_none());
        assert!(restore(&geometry(), &[], None).is_none());
        g = geometry();
        g.inner_width = 900;
        assert!(!valid(&g));
    }
    #[test]
    fn duplicate_names_prefer_exact_area() {
        let g = geometry();
        let other = screen("secondary", 0, 1920, 1.0);
        let result = restore(&g, &[other, g.display.clone()], None).unwrap();
        assert_eq!(result.outer.x, -1800);
    }
}
