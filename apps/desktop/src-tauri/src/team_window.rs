//! A display-only team panel window. Only the main window supplies team data.
//! Mirrors office.rs (see its header comment); geometry persistence is not needed here.
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, EventTarget, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

const LABEL: &str = "team";

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
}
#[derive(Default)]
pub struct TeamState {
    opening: tokio::sync::Mutex<()>,
    latest: Mutex<Option<Envelope>>,
    /// Set once main starts tearing down, so the team window's own Destroyed event
    /// (caused by main destroying it) is never mistaken for the user closing it.
    quitting: Mutex<bool>,
}

fn caller<R: tauri::Runtime>(window: &WebviewWindow<R>, expected: &str) -> Result<(), String> {
    if window.label() == expected {
        Ok(())
    } else {
        Err("Window is not permitted to perform this operation".into())
    }
}

/// `project`/`code` match dssh's board identifier pattern; `key` is a member key (bounded, non-empty).
fn identifier(value: &str) -> bool {
    value.len() <= 64
        && value
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Pure validator, kept separate from the command so it is directly testable: only the three
/// known shapes are accepted, with no extra fields (an unknown field is as invalid as an unknown kind).
pub fn valid_action(action: &serde_json::Value) -> bool {
    let Some(object) = action.as_object() else {
        return false;
    };
    match object.get("kind").and_then(|v| v.as_str()) {
        Some("open_member") => {
            object.len() == 2
                && object
                    .get("key")
                    .and_then(|v| v.as_str())
                    .is_some_and(|k| !k.is_empty() && k.len() <= 254)
        }
        Some("open_task") => {
            object.len() == 3
                && object
                    .get("project")
                    .and_then(|v| v.as_str())
                    .is_some_and(identifier)
                && object
                    .get("code")
                    .and_then(|v| v.as_str())
                    .is_some_and(identifier)
        }
        Some("refresh") => object.len() == 1,
        _ => false,
    }
}

#[tauri::command]
pub async fn team_publish_snapshot<R: tauri::Runtime>(
    window: WebviewWindow<R>,
    app: AppHandle<R>,
    state: State<'_, TeamState>,
    snapshot: serde_json::Value,
) -> Result<(), String> {
    caller(&window, "main")?;
    if app.get_webview_window(LABEL).is_none() {
        return Ok(());
    }
    if snapshot.get("version").and_then(|v| v.as_u64()) != Some(1)
        || !snapshot.get("members").is_some_and(|v| v.is_array())
    {
        return Err("Invalid team snapshot".into());
    }
    if serde_json::to_vec(&snapshot)
        .map_err(|e| e.to_string())?
        .len()
        > 2 * 1024 * 1024
    {
        return Err("Team snapshot is too large".into());
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
    app.emit_to(EventTarget::webview_window(LABEL), "team:snapshot", &envelope)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn team_request_snapshot(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TeamState>,
) -> Result<Initial, String> {
    caller(&window, LABEL)?;
    let snapshot = state.latest.lock().map_err(|e| e.to_string())?.clone();
    app.emit_to(EventTarget::webview_window("main"), "team:request", ())
        .map_err(|e| e.to_string())?;
    Ok(Initial { snapshot })
}

#[tauri::command]
pub fn team_window_exists(window: WebviewWindow, app: AppHandle) -> Result<bool, String> {
    caller(&window, "main")?;
    Ok(app.get_webview_window(LABEL).is_some())
}

// Monitor handle conversion can call platform display APIs even after a dispatched getter.
// Keep window operations on the UI thread, matching office.rs's helper.
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
pub async fn team_window_action(
    window: WebviewWindow,
    app: AppHandle,
    action: serde_json::Value,
) -> Result<(), String> {
    caller(&window, LABEL)?;
    if !valid_action(&action) {
        return Err("Invalid team window action".into());
    }
    app.emit_to(EventTarget::webview_window("main"), "team:action", &action)
        .map_err(|e| e.to_string())?;
    let handle = app.clone();
    on_main(&app, move || {
        if let Some(main) = handle.get_webview_window("main") {
            main.show().map_err(|e| e.to_string())?;
            main.unminimize().map_err(|e| e.to_string())?;
            main.set_focus().map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn open_team_window(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, TeamState>,
) -> Result<(), String> {
    caller(&window, "main")?;
    // Serialize check/build/focus against a concurrent call.
    let _opening = state.opening.lock().await;
    if let Some(existing) = app.get_webview_window(LABEL) {
        let handle = app.clone();
        return on_main(&app, move || {
            existing.show().map_err(|e| e.to_string())?;
            existing.unminimize().map_err(|e| e.to_string())?;
            existing.set_focus().map_err(|e| e.to_string())?;
            let _ = handle.emit_to(EventTarget::webview_window("main"), "team:presence", true);
            Ok(())
        })
        .await;
    }
    let builder = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#/team".into()))
        .title("dssh · 团队面板")
        .inner_size(440.0, 780.0)
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
    let team = builder.build().map_err(|e| e.to_string())?;
    on_main(&app, move || {
        let _ = team.center();
        team.show().map_err(|e| e.to_string())?;
        team.set_focus().map_err(|e| e.to_string())?;
        let _ = team.app_handle().emit_to(
            EventTarget::webview_window("main"),
            "team:presence",
            true,
        );
        Ok(())
    })
    .await
}

pub fn closes_team(label: &str, destroyed: bool) -> bool {
    label == "main" && destroyed
}
pub fn window_event(window: &tauri::Window, event: &WindowEvent) {
    let app = window.app_handle();
    if window.label() == "main"
        && matches!(event, WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed)
    {
        if let Ok(mut quitting) = app.state::<TeamState>().quitting.lock() {
            *quitting = true;
        }
    }
    if closes_team(window.label(), matches!(event, WindowEvent::Destroyed)) {
        if let Some(team) = app.get_webview_window(LABEL) {
            let _ = team.destroy();
        }
        return;
    }
    if window.label() != LABEL {
        return;
    }
    if matches!(event, WindowEvent::Destroyed) {
        let quitting = app
            .state::<TeamState>()
            .quitting
            .lock()
            .map(|q| *q)
            .unwrap_or(false);
        if !quitting {
            let _ = app.emit_to(EventTarget::webview_window("main"), "team:presence", false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::office::command_allowed;

    #[tokio::test]
    async fn actual_publish_command_checks_caller_and_advances_sequence() {
        let app = tauri::test::mock_builder()
            .manage(TeamState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let team = WebviewWindowBuilder::new(&app, "team", WebviewUrl::default())
            .build()
            .unwrap();
        let first = serde_json::json!({"version":1,"members":[],"themeId":"dark"});
        let second = serde_json::json!({"version":1,"members":[],"themeId":"light"});
        let denied =
            team_publish_snapshot(team, app.handle().clone(), app.state(), first.clone()).await;
        assert_eq!(
            denied,
            Err("Window is not permitted to perform this operation".into())
        );
        assert!(app.state::<TeamState>().latest.lock().unwrap().is_none());
        team_publish_snapshot(main.clone(), app.handle().clone(), app.state(), first)
            .await
            .unwrap();
        let epoch = app
            .state::<TeamState>()
            .latest
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .epoch
            .clone();
        assert_eq!(
            app.state::<TeamState>()
                .latest
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .sequence,
            1
        );
        team_publish_snapshot(main.clone(), app.handle().clone(), app.state(), second.clone())
            .await
            .unwrap();
        team_publish_snapshot(main, app.handle().clone(), app.state(), second.clone())
            .await
            .unwrap();
        let state = app.state::<TeamState>();
        let cache = state.latest.lock().unwrap();
        let envelope = cache.as_ref().unwrap();
        assert_eq!(envelope.sequence, 2);
        assert_eq!(envelope.epoch, epoch);
        assert_eq!(envelope.snapshot, second);
    }

    #[tokio::test]
    async fn absent_team_publish_leaves_cache_and_events_untouched() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tauri::Listener;
        let app = tauri::test::mock_builder()
            .manage(TeamState::default())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let main = WebviewWindowBuilder::new(&app, "main", WebviewUrl::default())
            .build()
            .unwrap();
        let events = Arc::new(AtomicUsize::new(0));
        let seen = events.clone();
        app.listen("team:snapshot", move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
        });
        team_publish_snapshot(
            main,
            app.handle().clone(),
            app.state(),
            serde_json::json!({"version":1,"members":[]}),
        )
        .await
        .unwrap();
        assert!(app.state::<TeamState>().latest.lock().unwrap().is_none());
        assert_eq!(events.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn team_capability_contains_only_event_permissions() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/team.json")).unwrap();
        assert_eq!(capability["windows"], serde_json::json!(["team"]));
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["core:event:allow-listen", "core:event:allow-unlisten"])
        );
    }

    #[test]
    fn team_window_commands_are_scoped_and_office_keeps_its_own() {
        for command in ["team_request_snapshot", "team_window_action", "desktop_report_error"] {
            assert!(command_allowed("team", command), "{command}");
        }
        for command in [
            "ssh_start",
            "office_request_snapshot",
            "team_publish_snapshot",
            "open_team_window",
            "team_window_exists",
        ] {
            assert!(!command_allowed("team", command), "{command}");
        }
        assert!(command_allowed("main", "team_publish_snapshot"));
        assert!(!command_allowed("office", "team_request_snapshot"));
    }

    #[test]
    fn main_destroyed_only_closes_team() {
        assert!(closes_team("main", true));
        assert!(!closes_team("main", false));
        assert!(!closes_team("team", true));
    }

    #[test]
    fn valid_action_accepts_the_three_known_shapes() {
        assert!(valid_action(&serde_json::json!({"kind":"open_member","key":"a@example.test"})));
        assert!(valid_action(&serde_json::json!({"kind":"open_task","project":"demo","code":"T1"})));
        assert!(valid_action(&serde_json::json!({"kind":"refresh"})));
    }

    #[test]
    fn valid_action_rejects_unknown_kinds_extra_fields_and_bad_patterns() {
        assert!(!valid_action(&serde_json::json!({"kind":"explode"})));
        assert!(!valid_action(&serde_json::json!({"kind":"refresh","extra":true})));
        assert!(!valid_action(
            &serde_json::json!({"kind":"open_member","key":"a","extra":true})
        ));
        assert!(!valid_action(&serde_json::json!({"kind":"open_member","key":""})));
        assert!(!valid_action(
            &serde_json::json!({"kind":"open_member","key":"a".repeat(255)})
        ));
        assert!(!valid_action(
            &serde_json::json!({"kind":"open_task","project":"-bad","code":"T1"})
        ));
        assert!(!valid_action(
            &serde_json::json!({"kind":"open_task","project":"demo","code":"has space"})
        ));
        assert!(!valid_action(
            &serde_json::json!({"kind":"open_task","project":"demo","code":"T1","extra":1})
        ));
        assert!(!valid_action(&serde_json::json!(["not","an","object"])));
        assert!(!valid_action(&serde_json::json!(null)));
    }
}
