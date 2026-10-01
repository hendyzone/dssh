//! Local interactive terminals: Unix PTYs and Windows ConPTY.
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize, SlavePty};
use std::{collections::HashMap, io::{Read, Write}, sync::{Arc, Mutex}};
use tauri::{Emitter, State};

struct Session {
    master: Box<dyn MasterPty + Send>,
    slave: Option<Box<dyn SlavePty + Send>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    reader: Option<Box<dyn Read + Send>>,
    command: Option<CommandBuilder>,
    killer: Option<Box<dyn ChildKiller + Send + Sync>>,
}
impl Drop for Session {
    fn drop(&mut self) { if let Some(child) = self.killer.as_mut() { let _ = child.kill(); } }
}

#[derive(Default, Clone)]
pub struct LocalState { sessions: Arc<Mutex<HashMap<String, Session>>> }
impl LocalState {
    pub fn shutdown(&self) { if let Ok(mut sessions) = self.sessions.lock() { sessions.clear(); } }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.max(1), rows: rows.max(1), pixel_width: 0, pixel_height: 0 }
}

fn connect(state: &LocalState, cols: u16, rows: u16, cwd: Option<String>) -> Result<String, String> {
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    let mut command = CommandBuilder::new_default_prog();
    #[cfg(windows)]
    let mut command = CommandBuilder::new("powershell.exe");
    #[cfg(windows)]
    command.arg("-NoLogo");
    #[cfg(unix)]
    command.env_remove("SHELL");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "dssh");
    let cwd = cwd.filter(|p| std::path::Path::new(p).is_dir())
        .or_else(|| std::env::var("HOME").ok()).or_else(|| std::env::var("USERPROFILE").ok());
    if let Some(cwd) = cwd { command.cwd(cwd); }
    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let id = format!("local-{:032x}", rand::random::<u128>());
    state.sessions.lock().map_err(|e| e.to_string())?.insert(id.clone(), Session {
        master: pair.master, slave: Some(pair.slave), writer: Arc::new(Mutex::new(writer)), reader: Some(reader),
        command: Some(command), killer: None,
    });
    Ok(id)
}

// Keep incomplete UTF-8 between reads, including split Chinese characters.
fn decode(pending: &mut Vec<u8>, bytes: &[u8], eof: bool) -> String {
    pending.extend_from_slice(bytes);
    let mut output = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => { output.push_str(text); pending.clear(); break; }
            Err(error) => {
                let valid = error.valid_up_to();
                output.push_str(std::str::from_utf8(&pending[..valid]).unwrap());
                pending.drain(..valid);
                if let Some(len) = error.error_len() {
                    output.push('\u{fffd}'); pending.drain(..len);
                } else {
                    if eof { output.push_str(&String::from_utf8_lossy(pending)); pending.clear(); }
                    break;
                }
            }
        }
    }
    output
}

fn start(app: tauri::AppHandle, state: &LocalState, session_id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&session_id).ok_or("本地终端已关闭")?;
    let Some(command) = session.command.take() else { return Ok(()); };
    let slave = session.slave.take().ok_or("本地终端无法启动")?;
    let mut child = slave.spawn_command(command).map_err(|e| e.to_string())?;
    session.killer = Some(child.clone_killer());
    drop(slave);
    let mut reader = session.reader.take().ok_or("本地终端无法读取")?;
    let registry = state.sessions.clone();
    drop(sessions);
    let (status_tx, status_rx) = std::sync::mpsc::channel();
    let waiter_id = session_id.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code() as i64).unwrap_or(-1);
        if let Ok(mut sessions) = registry.lock() {
            if let Some(mut session) = sessions.remove(&waiter_id) { session.killer = None; }
        }
        let _ = status_tx.send(code);
    });
    std::thread::spawn(move || {
        let mut buffer = [0u8; 16384];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let text = decode(&mut pending, &buffer[..n], false);
                    if !text.is_empty() { let _ = app.emit(&format!("local://{session_id}/data"), text); }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let tail = decode(&mut pending, &[], true);
        if !tail.is_empty() { let _ = app.emit(&format!("local://{session_id}/data"), tail); }
        let code = status_rx.recv().unwrap_or(-1);
        let _ = app.emit(&format!("local://{session_id}/exit"), code);
    });
    Ok(())
}

fn write(state: &LocalState, session_id: String, data: String) -> Result<(), String> {
    let writer = state.sessions.lock().map_err(|e| e.to_string())?
        .get(&session_id).ok_or("本地终端已关闭")?.writer.clone();
    let mut writer = writer.lock().map_err(|e| e.to_string())?;
    writer.write_all(data.as_bytes()).and_then(|_| writer.flush()).map_err(|e| e.to_string())
}

fn resize(state: &LocalState, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.get(&session_id).ok_or("本地终端已关闭")?.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

fn disconnect(state: &LocalState, session_id: String) -> Result<(), String> {
    state.sessions.lock().map_err(|e| e.to_string())?.remove(&session_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pty_delivers_output_and_resizes() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        pair.master.resize(size(100, 30)).unwrap();
        assert_eq!(pair.master.get_size().unwrap().cols, 100);
        #[cfg(windows)]
        let mut cmd = CommandBuilder::new("cmd.exe");
        #[cfg(windows)]
        cmd.args(["/c", "echo local-shell-ready"]);
        #[cfg(unix)]
        let mut cmd = CommandBuilder::new("/bin/sh");
        #[cfg(unix)]
        cmd.args(["-c", "printf 'local-shell-ready\\n'"]);
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut output = String::new();
            let mut buf = [0; 1024];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 { break; }
                output.push_str(&String::from_utf8_lossy(&buf[..n]));
                if output.contains("\x1b[6n") {
                    let _ = writer.write_all(b"\x1b[1;1R");
                    let _ = writer.flush();
                }
                if output.contains("local-shell-ready") { break; }
            }
            let _ = tx.send(output);
        });
        let output = rx.recv_timeout(std::time::Duration::from_secs(15));
        if output.is_err() { let _ = child.kill(); }
        assert!(output.unwrap().contains("local-shell-ready"));
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn disconnecting_an_unstarted_session_releases_it() {
        let state = LocalState::default();
        let id = connect(&state, 80, 24, None).unwrap();
        resize(&state, id.clone(), 120, 40).unwrap();
        disconnect(&state, id.clone()).unwrap();
        assert!(write(&state, id.clone(), "hello".into()).is_err());
        assert!(disconnect(&state, id).is_ok());
    }

    #[test]
    fn preserves_split_utf8_and_replaces_invalid_input() {
        let mut pending = Vec::new();
        assert_eq!(decode(&mut pending, &[0xe4, 0xbd], false), "");
        assert_eq!(decode(&mut pending, &[0xa0, 0xff, b'!'], false), "你�!");
        assert_eq!(decode(&mut pending, &[0xe4], true), "�");
        assert!(pending.is_empty());
    }
}

#[tauri::command]
pub async fn local_connect(state: State<'_, LocalState>, cols: u16, rows: u16, cwd: Option<String>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connect(&state, cols, rows, cwd)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_start(app: tauri::AppHandle, state: State<'_, LocalState>, session_id: String) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || start(app, &state, session_id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_write(state: State<'_, LocalState>, session_id: String, data: String) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || write(&state, session_id, data)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_resize(state: State<'_, LocalState>, session_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || resize(&state, session_id, cols, rows)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn local_disconnect(state: State<'_, LocalState>, session_id: String) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || disconnect(&state, session_id)).await.map_err(|e| e.to_string())?
}
