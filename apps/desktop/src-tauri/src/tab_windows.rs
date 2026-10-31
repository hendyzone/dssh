//! Detached tabs are reconnect transactions, never transfers of a live terminal.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::Mutex,
    time::Duration,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Opening,
    Detached,
    Returning,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub descriptor: Value,
    pub phase: Phase,
    pub error: Option<String>,
    pub revision: u64,
}
#[derive(Default)]
pub struct TabWindows {
    entries: Mutex<HashMap<String, Entry>>,
    pub owners: Mutex<HashMap<String, String>>,
    quitting: Mutex<bool>,
    connecting: tokio::sync::Mutex<()>,
    drop_zone: Mutex<Option<DropZone>>,
    cancelled_drags: Mutex<HashSet<String>>,
}
fn main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Main window required".into())
    }
}
fn label(id: &str) -> String {
    format!("detached-{id}")
}
fn own(window: &WebviewWindow, id: &str) -> Result<(), String> {
    if window.label() == label(id) {
        Ok(())
    } else {
        Err("Wrong detached window".into())
    }
}
fn entries(state: &TabWindows) -> Vec<Entry> {
    state.entries.lock().unwrap().values().cloned().collect()
}
fn publish(app: &AppHandle) {
    let state = app.state::<TabWindows>();
    // Hold the snapshot lock through emission so concurrent transactions cannot
    // publish an older list after a newer one.
    let map = state.entries.lock().unwrap();
    let list: Vec<Entry> = map.values().cloned().collect();
    let _ = app.emit_to(
        tauri::EventTarget::webview_window("main"),
        "tabs:changed",
        &list,
    );
    for entry in &list {
        let _ = app.emit_to(
            tauri::EventTarget::webview_window(label(&entry.id)),
            "tabs:changed",
            std::slice::from_ref(entry),
        );
    }
}
pub fn register(app: &AppHandle, owner: &str, id: &str) -> Result<(), String> {
    if app.get_webview_window(owner).is_none() {
        return Err("Window closed while connecting".into());
    }
    app.state::<TabWindows>()
        .owners
        .lock()
        .unwrap()
        .insert(id.into(), owner.into());
    Ok(())
}
// Called before app command dispatch: detached windows cannot choose a server,
// another window's connection, a write API or an arbitrary filesystem path.
pub fn allowed(state: &TabWindows, owner: &str, command: &str, args: &Value) -> bool {
    if !owner.starts_with("detached-") {
        return true;
    }
    if matches!(
        command,
        "tab_snapshot"
            | "tab_connect"
            | "tab_ready"
            | "tab_return"
            | "tab_failed"
            | "tab_drag_end"
            | "desktop_report_error"
    ) {
        return true;
    }
    let Some(id) = args.get("sessionId").and_then(Value::as_str) else {
        return false;
    };
    if state.owners.lock().unwrap().get(id).map(String::as_str) != Some(owner) {
        return false;
    }
    if matches!(
        command,
        "ssh_start"
            | "ssh_write"
            | "ssh_resize"
            | "ssh_disconnect"
            | "local_start"
            | "local_write"
            | "local_resize"
            | "local_disconnect"
    ) {
        return true;
    }
    if matches!(command, "sftp_read_text" | "sftp_read_image") {
        let map = state.entries.lock().unwrap();
        let Some(e) = map.get(owner.trim_start_matches("detached-")) else {
            return false;
        };
        let Some(path) = args.get("path").and_then(Value::as_str) else {
            return false;
        };
        let Some(root) = e
            .descriptor
            .pointer("/page/target/path")
            .and_then(Value::as_str)
        else {
            return false;
        };
        // Markdown images may live under the document directory; no traversal.
        return path == root
            || (command == "sftp_read_image"
                && !std::path::Path::new(path)
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
                && std::path::Path::new(root)
                    .parent()
                    .is_some_and(|p| std::path::Path::new(path).starts_with(p)));
    }
    false
}
fn validate(d: &Value) -> Result<(), String> {
    if serde_json::to_vec(d).map_err(|e| e.to_string())?.len() > 64 * 1024 {
        return Err("Tab description too large".into());
    }
    match d.get("kind").and_then(Value::as_str) {
        Some("terminal") => {
            let panes = d
                .pointer("/tab/panes")
                .and_then(Value::as_array)
                .ok_or("Missing panes")?;
            if panes.len() != 1 {
                return Err("Only single-pane tmux tabs can detach".into());
            }
            let target: crate::tmux::Target = serde_json::from_value(
                panes[0]
                    .get("tmux")
                    .cloned()
                    .ok_or("A tmux session is required")?,
            )
            .map_err(|e| e.to_string())?;
            crate::tmux::attach_command(&target)?;
        }
        Some("preview") => {
            let target = d.pointer("/page/target").ok_or("Missing preview target")?;
            if target.get("kind").and_then(Value::as_str) == Some("url") {
                let url = tauri::Url::parse(
                    target
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or("Missing URL")?,
                )
                .map_err(|e| e.to_string())?;
                if !matches!(url.scheme(), "http" | "https")
                    || url.host_str().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return Err("Invalid preview URL".into());
                }
            } else if !matches!(
                target.get("kind").and_then(Value::as_str),
                Some("html" | "markdown" | "image")
            ) || !target
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|p| p.starts_with('/') && !p.chars().any(char::is_control))
            {
                return Err("Invalid preview path".into());
            }
        }
        _ => return Err("Unsupported tab".into()),
    }
    Ok(())
}
fn timeout(app: AppHandle, id: String, revision: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let state = app.state::<TabWindows>();
        let phase = state
            .entries
            .lock()
            .unwrap()
            .get(&id)
            .filter(|e| e.revision == revision)
            .map(|e| e.phase.clone());
        if matches!(phase, Some(Phase::Opening | Phase::Returning)) {
            fail(&app, &id, "连接超时，已保留原窗口");
        }
    });
}
fn fail(app: &AppHandle, id: &str, error: &str) {
    let state = app.state::<TabWindows>();
    let destroy = {
        let mut map = state.entries.lock().unwrap();
        match map.get_mut(id) {
            Some(e) if e.phase == Phase::Opening => {
                map.remove(id);
                true
            }
            Some(e) if e.phase == Phase::Returning => {
                if app.get_webview_window(&label(id)).is_none() {
                    map.remove(id);
                } else {
                    e.phase = Phase::Detached;
                    e.error = Some(error.into());
                    e.revision += 1;
                }
                false
            }
            _ => false,
        }
    };
    publish(app);
    let _ = app.emit_to(
        tauri::EventTarget::webview_window("main"),
        "tabs:error",
        error,
    );
    if destroy {
        if let Some(w) = app.get_webview_window(&label(id)) {
            let _ = w.destroy();
        }
    }
}
#[tauri::command]
pub fn tab_snapshot(window: WebviewWindow, state: State<'_, TabWindows>) -> Vec<Entry> {
    entries(&state)
        .into_iter()
        .filter(|e| window.label() == "main" || window.label() == label(&e.id))
        .collect()
}
#[tauri::command]
pub async fn tab_open(
    window: WebviewWindow,
    app: AppHandle,
    descriptor: Value,
    position: Option<PhysicalPosition<f64>>,
) -> Result<String, String> {
    main(&window)?;
    validate(&descriptor)?;
    let state = app.state::<TabWindows>();
    if *state.quitting.lock().unwrap() {
        return Err("Application is closing".into());
    }
    let id = format!("{:032x}", rand::random::<u128>());
    {
        let mut map = state.entries.lock().unwrap();
        if map
            .values()
            .any(|e| e.descriptor.get("sourceId") == descriptor.get("sourceId"))
        {
            return Err("Tab already detached".into());
        }
        map.insert(
            id.clone(),
            Entry {
                id: id.clone(),
                descriptor,
                phase: Phase::Opening,
                error: None,
                revision: 0,
            },
        );
    }
    let result = WebviewWindowBuilder::new(
        &app,
        label(&id),
        WebviewUrl::App(format!("index.html#/detached/{id}").into()),
    )
    .title("dssh · 独立标签")
    .inner_size(900., 620.)
    .build();
    match result {
        Ok(child) => {
            observe_native_drag(&child);
            #[cfg(any(windows, target_os = "linux"))]
            let _ = child.hide_menu();
            if let Some(p) = position {
                let _ = child.set_position(p);
            }
        }
        Err(e) => {
            state.entries.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
    }
    publish(&app);
    timeout(app, id.clone(), 0);
    Ok(id)
}
#[tauri::command]
pub fn tab_ready(window: WebviewWindow, app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<TabWindows>();
    let returning = {
        let mut map = state.entries.lock().unwrap();
        let e = map.get_mut(&id).ok_or("Tab transaction no longer exists")?;
        match e.phase {
            Phase::Opening => {
                own(&window, &id)?;
                e.phase = Phase::Detached;
                e.revision += 1;
                false
            }
            Phase::Returning => {
                main(&window)?;
                map.remove(&id);
                true
            }
            Phase::Detached => {
                own(&window, &id)?;
                return Ok(());
            }
        }
    };
    publish(&app);
    if returning {
        if let Some(w) = app.get_webview_window(&label(&id)) {
            w.destroy().map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
fn returning(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<TabWindows>();
    if *state.quitting.lock().unwrap() {
        return Ok(());
    }
    let revision = {
        let mut map = state.entries.lock().unwrap();
        let e = map.get_mut(id).ok_or("Unknown detached tab")?;
        if e.phase == Phase::Returning {
            return Ok(());
        }
        if e.phase == Phase::Opening {
            drop(map);
            fail(app, id, "已取消打开独立窗口");
            return Ok(());
        }
        begin_return(e);
        e.revision
    };
    publish(app);
    timeout(app.clone(), id.into(), revision);
    Ok(())
}
#[tauri::command]
pub fn tab_return(window: WebviewWindow, app: AppHandle, id: String) -> Result<(), String> {
    own(&window, &id)?;
    returning(&app, &id)
}
#[tauri::command]
pub fn tab_failed(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    error: String,
) -> Result<(), String> {
    if window.label() != "main" {
        own(&window, &id)?;
    }
    fail(&app, &id, &error);
    Ok(())
}
#[tauri::command]
pub fn tab_quit(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main(&window)?;
    *app.state::<TabWindows>().quitting.lock().unwrap() = true;
    for w in app
        .webview_windows()
        .values()
        .filter(|w| w.label().starts_with("detached-"))
    {
        let _ = w.destroy();
    }
    Ok(())
}
#[derive(Serialize)]
pub struct DragEnd {
    outside: bool,
    position: PhysicalPosition<f64>,
}
#[tauri::command]
pub fn tab_drag_end(
    window: WebviewWindow,
    app: AppHandle,
    id: Option<String>,
) -> Result<DragEnd, String> {
    let p = window.cursor_position().map_err(|e| e.to_string())?;
    if drag_cancelled(&app.state::<TabWindows>(), window.label()) {
        return Ok(DragEnd {
            outside: false,
            position: p,
        });
    }
    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window unavailable")?;
    let origin = main_window.inner_position().map_err(|e| e.to_string())?;
    let size = main_window.inner_size().map_err(|e| e.to_string())?;
    let inside = p.x >= origin.x as f64
        && p.x < (origin.x as f64 + size.width as f64)
        && p.y >= origin.y as f64
        && p.y < (origin.y as f64 + size.height as f64);
    if window.label() != "main" {
        let id = id.ok_or("Missing tab")?;
        own(&window, &id)?;
        let scale = main_window.scale_factor().map_err(|e| e.to_string())?;
        let relative = (
            (p.x - origin.x as f64) / scale,
            (p.y - origin.y as f64) / scale,
        );
        let zone = app.state::<TabWindows>().drop_zone.lock().unwrap().clone();
        if inside && zone.is_some_and(|z| z.contains(relative.0, relative.1)) {
            returning(&app, &id)?;
        }
    }
    Ok(DragEnd {
        outside: !inside,
        position: p,
    })
}
pub fn window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    if let Some(id) = window.label().strip_prefix("detached-") {
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = returning(app, id);
            }
            WindowEvent::Destroyed => {
                cleanup(app, window.label());
                let state = app.state::<TabWindows>();
                // Unexpected destruction returns the retained description to main.
                // Normal acknowledgement/rollback removed the entry before destroy.
                if !*state.quitting.lock().unwrap() {
                    {
                        let mut map = state.entries.lock().unwrap();
                        if let Some(e) = map.get_mut(id) {
                            if e.phase == Phase::Opening {
                                map.remove(id);
                            } else {
                                begin_return(e);
                            }
                        }
                    }
                    publish(app);
                }
            }
            _ => {}
        }
    } else if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
        *app.state::<TabWindows>().quitting.lock().unwrap() = true;
        for w in app
            .webview_windows()
            .values()
            .filter(|w| w.label().starts_with("detached-"))
        {
            let _ = w.destroy();
        }
        cleanup(app, "main");
    }
}
fn cleanup(app: &AppHandle, owner: &str) {
    let state = app.state::<TabWindows>();
    let ids: Vec<String> = {
        let mut owners = state.owners.lock().unwrap();
        let ids = owners
            .iter()
            .filter(|(_, v)| v.as_str() == owner)
            .map(|(k, _)| k.clone())
            .collect();
        owners.retain(|_, v| v != owner);
        ids
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        for id in ids {
            if id.starts_with("local-") {
                let _ = crate::local_shell::local_disconnect(app.clone(), app.state(), id).await;
            } else {
                let _ = crate::ssh::ssh_disconnect(app.clone(), app.state(), id).await;
            }
        }
    });
}
#[tauri::command]
pub async fn tab_connect(
    window: WebviewWindow,
    app: AppHandle,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    // Serialize reload/reconnect attempts so a destroyed WebView cannot leave
    // late connections behind or replace a newer connection.
    let state = app.state::<TabWindows>();
    let _connecting = state.connecting.lock().await;
    let d = {
        let state = app.state::<TabWindows>();
        let map = state.entries.lock().unwrap();
        let e = map.get(&id).ok_or("Unknown detached tab")?;
        if window.label() != "main" {
            own(&window, &id)?;
        } else if e.phase != Phase::Returning {
            return Err("Tab is not returning".into());
        }
        e.descriptor.clone()
    };
    if window.label() != "main" {
        let ids: Vec<String> = state
            .owners
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, owner)| owner.as_str() == window.label())
            .map(|(id, _)| id.clone())
            .collect();
        for old in ids {
            if old.starts_with("local-") {
                crate::local_shell::local_disconnect(app.clone(), app.state(), old).await?;
            } else {
                crate::ssh::ssh_disconnect(app.clone(), app.state(), old)
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    let pane = if d["kind"] == "terminal" {
        &d["tab"]["panes"][0]
    } else {
        &d["page"]
    };
    let server = &pane["server"];
    let tmux = if d["kind"] == "terminal" {
        Some(
            serde_json::from_value(pane["tmux"].clone())
                .map_err(|e| format!("Invalid tmux: {e}"))?,
        )
    } else {
        None
    };
    let workdir = pane["tmuxWorkdir"].as_str().map(String::from);
    if server["kind"] == "local" {
        if tmux.is_none() {
            return Err("Local file preview is unsupported".into());
        }
        return crate::local_shell::local_connect(
            window,
            app.clone(),
            app.state(),
            cols,
            rows,
            None,
            tmux,
            workdir,
        )
        .await;
    }
    let record = crate::servers::read_all(&app)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|s| Some(s.id.as_str()) == server["id"].as_str())
        .ok_or("Saved server no longer exists")?;
    if Some(record.host.as_str()) != server["host"].as_str()
        || Some(record.port as u64) != server["port"].as_u64()
        || Some(record.username.as_str()) != server["username"].as_str()
    {
        return Err("Saved server target changed".into());
    }
    let params = crate::ssh::ConnectParams {
        host: record.host,
        port: record.port,
        username: record.username,
        auth_method: record.auth_method,
        secret: record.key_path,
        passphrase: None,
        server_id: Some(record.id),
        cols: cols as u32,
        rows: rows as u32,
        tmux,
        tmux_workdir: workdir,
    };
    crate::ssh::ssh_connect(window, app.clone(), app.state(), params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn tab_restore_preview(
    window: WebviewWindow,
    app: AppHandle,
    descriptor: Value,
) -> Result<String, String> {
    main(&window)?;
    validate(&descriptor)?;
    if descriptor["kind"] != "preview" {
        return Err("Only preview recovery uses this command".into());
    }
    let state = app.state::<TabWindows>();
    let id = {
        let mut map = state.entries.lock().unwrap();
        if let Some(e) = map
            .values()
            .find(|e| e.descriptor["sourceId"] == descriptor["sourceId"])
        {
            return Ok(e.id.clone());
        }
        let id = format!("{:032x}", rand::random::<u128>());
        map.insert(
            id.clone(),
            Entry {
                id: id.clone(),
                descriptor,
                phase: Phase::Returning,
                error: None,
                revision: 0,
            },
        );
        id
    };
    publish(&app);
    Ok(id)
}

fn begin_return(entry: &mut Entry) {
    entry.phase = Phase::Returning;
    entry.error = None;
    entry.revision += 1;
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn terminal() -> Value {
        json!({"kind":"terminal","sourceId":"tab","tab":{"panes":[{"tmux":{"id":"$4","created":123}}]}})
    }
    #[test]
    fn rejects_shell_multi_pane_and_invalid_targets() {
        assert!(validate(&terminal()).is_ok());
        let mut d = terminal();
        d["tab"]["panes"][0]["tmux"] = Value::Null;
        assert!(validate(&d).is_err());
        let mut d = terminal();
        d["tab"]["panes"].as_array_mut().unwrap().push(json!({}));
        assert!(validate(&d).is_err());
        let mut d = terminal();
        d["tab"]["panes"][0]["tmux"]["id"] = json!("$(exit)");
        assert!(validate(&d).is_err());
        assert!(validate(
            &json!({"kind":"preview","page":{"target":{"kind":"url","url":"file:///etc/passwd"}}})
        )
        .is_err());
    }
    #[test]
    fn return_keeps_description_until_main_is_ready() {
        let d = terminal();
        let mut e = Entry {
            id: "a".into(),
            descriptor: d.clone(),
            phase: Phase::Detached,
            error: Some("old".into()),
            revision: 5,
        };
        begin_return(&mut e);
        assert_eq!(e.phase, Phase::Returning);
        assert_eq!(e.descriptor, d);
        assert_eq!(e.revision, 6);
        assert!(e.error.is_none());
    }
    #[test]
    fn detached_commands_cannot_access_another_connection_or_write_api() {
        let s = TabWindows::default();
        s.owners
            .lock()
            .unwrap()
            .insert("own".into(), "detached-a".into());
        s.owners
            .lock()
            .unwrap()
            .insert("foreign".into(), "main".into());
        assert!(allowed(
            &s,
            "detached-a",
            "ssh_resize",
            &json!({"sessionId":"own"})
        ));
        assert!(!allowed(
            &s,
            "detached-a",
            "ssh_write",
            &json!({"sessionId":"foreign"})
        ));
        for command in [
            "ssh_connect",
            "local_connect",
            "servers_list",
            "servers_upsert",
            "team_service_configure",
            "sftp_save_text",
            "tmux_action",
        ] {
            assert!(
                !allowed(&s, "detached-a", command, &json!({"sessionId":"own"})),
                "{command}"
            );
        }
    }
    #[test]
    fn preview_reads_are_limited_to_registered_target_and_relative_images() {
        let s = TabWindows::default();
        s.owners
            .lock()
            .unwrap()
            .insert("own".into(), "detached-a".into());
        s.entries.lock().unwrap().insert("a".into(),Entry{id:"a".into(),descriptor:json!({"kind":"preview","page":{"target":{"kind":"markdown","path":"/repo/README.md"}}}),phase:Phase::Detached,error:None,revision:1});
        assert!(allowed(
            &s,
            "detached-a",
            "sftp_read_text",
            &json!({"sessionId":"own","path":"/repo/README.md"})
        ));
        assert!(!allowed(
            &s,
            "detached-a",
            "sftp_read_text",
            &json!({"sessionId":"own","path":"/repo/secrets.txt"})
        ));
        assert!(allowed(
            &s,
            "detached-a",
            "sftp_read_image",
            &json!({"sessionId":"own","path":"/repo/images/demo.png"})
        ));
        assert!(!allowed(
            &s,
            "detached-a",
            "sftp_read_image",
            &json!({"sessionId":"own","path":"/repo/../other/demo.png"})
        ));
        assert!(!allowed(
            &s,
            "detached-a",
            "sftp_read_image",
            &json!({"sessionId":"own","path":"/other/demo.png"})
        ));
    }
}

#[derive(Clone, Deserialize)]
pub struct DropZone {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}
impl DropZone {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}
#[tauri::command]
pub fn tab_drop_zone(
    window: WebviewWindow,
    state: State<'_, TabWindows>,
    zone: DropZone,
) -> Result<(), String> {
    main(&window)?;
    if ![zone.x, zone.y, zone.width, zone.height]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.)
    {
        return Err("Invalid tab strip bounds".into());
    }
    *state.drop_zone.lock().unwrap() = Some(zone);
    Ok(())
}

/// Main WebView reloads keep native children, but must retire its old connections
/// before restoring the saved tabs and opening their replacements.
#[tauri::command]
pub async fn tab_main_mount(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main(&window)?;
    let ids: Vec<String> = app
        .state::<TabWindows>()
        .owners
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, owner)| owner.as_str() == "main")
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if id.starts_with("local-") {
            crate::local_shell::local_disconnect(app.clone(), app.state(), id).await?;
        } else {
            crate::ssh::ssh_disconnect(app.clone(), app.state(), id)
                .await
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// GTK swallows Escape during its native DND loop, before DOM keydown handlers.
/// NoTarget is a normal release outside any window; all other failures cancel.
pub fn observe_native_drag(window: &WebviewWindow) {
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let app = window.app_handle().clone();
        let owner = window.label().to_string();
        let _ = window.with_webview(move |webview| {
            let begin_app = app.clone();
            let begin_owner = owner.clone();
            webview.inner().connect_drag_begin(move |_, _| {
                begin_app
                    .state::<TabWindows>()
                    .cancelled_drags
                    .lock()
                    .unwrap()
                    .remove(&begin_owner);
            });
            webview.inner().connect_drag_failed(move |_, _, result| {
                if !matches!(result, gtk::DragResult::Success | gtk::DragResult::NoTarget) {
                    app.state::<TabWindows>()
                        .cancelled_drags
                        .lock()
                        .unwrap()
                        .insert(owner.clone());
                }
                gtk::glib::Propagation::Proceed
            });
        });
    }
    #[cfg(not(target_os = "linux"))]
    let _ = window;
}
fn drag_cancelled(state: &TabWindows, owner: &str) -> bool {
    if state.cancelled_drags.lock().unwrap().remove(owner) {
        return true;
    }
    // Native DND cancellation may not reach DOM keydown on other platforms either.
    // A normal drop ends on mouse release; Escape cancellation ends while held.
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(key: i32) -> i16;
        }
        return unsafe { GetAsyncKeyState(0x1B) < 0 || GetAsyncKeyState(0x01) < 0 };
    }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "ApplicationServices", kind = "framework")]
        extern "C" {
            fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
            fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
        }
        return unsafe { CGEventSourceKeyState(0, 53) || CGEventSourceButtonState(0, 0) };
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    false
}
