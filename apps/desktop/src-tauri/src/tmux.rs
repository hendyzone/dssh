//! tmux control through separate SSH exec channels. Never type commands into an interactive pane.
use crate::ssh::{SharedHandle, SshState};
use std::time::Duration;
use tauri::State;
const SEPARATOR: &str = "|DSSH-TMUX|";

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub created: u64,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxSession {
    pub id: String,
    pub name: String,
    pub windows: u32,
    pub attached: u32,
    pub created: u64,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxPane {
    pub session_id: String,
    pub window_id: String,
    pub window_index: u32,
    pub window_name: String,
    pub window_active: bool,
    pub id: String,
    pub index: u32,
    pub active: bool,
    pub command: String,
    pub path: String,
    pub zoomed: bool,
}
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub installed: bool,
    pub version: String,
    pub sessions: Vec<TmuxSession>,
    pub panes: Vec<TmuxPane>,
}

pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn valid_id(value: &str, prefix: char) -> bool {
    value.starts_with(prefix) && value.len() > 1 && value[1..].bytes().all(|b| b.is_ascii_digit())
}
fn name(value: Option<&str>) -> Result<String, String> {
    let value = value.unwrap_or("").trim();
    if value.contains(SEPARATOR)
        || value.is_empty()
        || value.chars().count() > 64
        || value
            .chars()
            .any(|c| c.is_control() || c == ':' || c == '.')
    {
        return Err("名称须为 1–64 个字符，不能包含冒号、句点或控制字符".into());
    }
    Ok(quote(value))
}
pub fn attach_command(target: &Target) -> Result<String, String> {
    if !valid_id(&target.id, '$') {
        return Err("无效的 tmux 会话 ID".into());
    }
    Ok(format!("unset TMUX; command -v tmux >/dev/null 2>&1 || {{ printf 'tmux is not installed\\n'; exit 127; }}; {} tmux set-option -t {} mouse on || exit $?; exec env TERM_PROGRAM=ghostty COLORTERM=truecolor tmux attach-session -t {}", identity_guard(target), quote(&target.id), quote(&target.id)))
}
fn identity_guard(target: &Target) -> String {
    format!("[ \"$(tmux display-message -p -t {} '#{{session_created}}' 2>/dev/null)\" = {} ] || {{ printf 'tmux session no longer exists; refresh the session list\\n' >&2; exit 1; }};",quote(&target.id),quote(&target.created.to_string()))
}
const SNAPSHOT: &str = r#"unset TMUX
export LC_ALL=C
if ! command -v tmux >/dev/null 2>&1; then printf 'DSSH_TMUX_MISSING\n'; exit 0; fi
printf 'DSSH_TMUX_VERSION\n'; tmux -V
printf 'DSSH_TMUX_SESSIONS\n'
dssh_tmux_sessions=$(tmux list-sessions -F '#{session_id}\t#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}' 2>&1)
dssh_tmux_exit_code=$?
if [ "$dssh_tmux_exit_code" -ne 0 ]; then
  case "$dssh_tmux_sessions" in
    "no server running on "*|"error connecting to "*"(No such file or directory)") exit 0 ;;
    *) printf '%s\n' "$dssh_tmux_sessions" >&2; exit "$dssh_tmux_exit_code" ;;
  esac
fi
printf '%s\n' "$dssh_tmux_sessions"
printf 'DSSH_TMUX_PANES\n'
tmux list-panes -a -F '#{session_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}\t#{window_zoomed_flag}' || exit $?
exit 0
"#;

pub(crate) async fn execute(handle: &SharedHandle, command: &str) -> Result<String, String> {
    let mut channel = tokio::time::timeout(Duration::from_secs(10), handle.channel_open_session())
        .await
        .map_err(|_| "SSH 通道超时")?
        .map_err(|e| e.to_string())?;
    let result = tokio::time::timeout(Duration::from_secs(12), async {
        channel
            .exec(true, command)
            .await
            .map_err(|e| e.to_string())?;
        let mut output = Vec::new();
        let mut errors = Vec::new();
        let mut status = None;
        while let Some(message) = channel.wait().await {
            match message {
                russh::ChannelMsg::Data { data } => output.extend_from_slice(&data),
                russh::ChannelMsg::ExtendedData { data, .. } => errors.extend_from_slice(&data),
                russh::ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                russh::ChannelMsg::Close => break,
                _ => {}
            }
            if output.len() + errors.len() > 2 * 1024 * 1024 {
                return Err("tmux 输出超过限制".into());
            }
        }
        if status != Some(0) {
            return Err(format!(
                "tmux 操作失败：{}",
                String::from_utf8_lossy(&errors).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&output).into_owned())
    })
    .await
    .map_err(|_| "tmux 操作超时，请刷新确认远端状态".to_string())
    .and_then(|r| r);
    let _ = channel.close().await;
    result
}
fn parse_snapshot(text: &str) -> Result<Snapshot, String> {
    if text.trim() == "DSSH_TMUX_MISSING" {
        return Ok(Snapshot {
            installed: false,
            version: String::new(),
            sessions: vec![],
            panes: vec![],
        });
    }
    let mut section = "";
    let mut snapshot = Snapshot {
        installed: true,
        version: String::new(),
        sessions: vec![],
        panes: vec![],
    };
    for line in text.lines() {
        if line.starts_with("DSSH_TMUX_") {
            section = line;
            continue;
        }
        // tmux sanitizes control characters, so use a printable field separator.
        let c: Vec<_> = line.split(SEPARATOR).collect();
        match section {
            "DSSH_TMUX_VERSION" => snapshot.version = line.into(),
            "DSSH_TMUX_SESSIONS" if c.len() == 5 && valid_id(c[0], '$') => {
                if let (Ok(windows), Ok(attached), Ok(created)) =
                    (c[2].parse(), c[3].parse(), c[4].parse())
                {
                    snapshot.sessions.push(TmuxSession {
                        id: c[0].into(),
                        name: c[1].into(),
                        windows,
                        attached,
                        created,
                    });
                }
            }
            "DSSH_TMUX_PANES"
                if c.len() == 11
                    && valid_id(c[0], '$')
                    && valid_id(c[1], '@')
                    && valid_id(c[5], '%') =>
            {
                if let (Ok(window_index), Ok(index)) = (c[2].parse(), c[6].parse()) {
                    snapshot.panes.push(TmuxPane {
                        session_id: c[0].into(),
                        window_id: c[1].into(),
                        window_index,
                        window_name: c[3].into(),
                        window_active: c[4] == "1",
                        id: c[5].into(),
                        index,
                        active: c[7] == "1",
                        command: c[8].into(),
                        path: c[9].into(),
                        zoomed: c[10] == "1",
                    });
                }
            }
            _ => {}
        }
    }
    if !snapshot.version.starts_with("tmux ") {
        return Err("无法读取 tmux 版本".into());
    }
    Ok(snapshot)
}
#[tauri::command]
pub async fn tmux_snapshot(
    ssh: State<'_, SshState>,
    session_id: String,
) -> Result<Snapshot, String> {
    let handle = ssh.get_handle(&session_id).await.ok_or("SSH 连接已断开")?;
    parse_snapshot(&execute(&handle, &SNAPSHOT.replace("\\t", SEPARATOR)).await?)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub action: String,
    pub session: Option<Target>,
    pub target: Option<String>,
    pub name: Option<String>,
}
fn unzoom_guard(target: &str) -> String {
    format!("if [ \"$(tmux display-message -p -t {target} '#{{window_zoomed_flag}}')\" = 1 ]; then tmux resize-pane -Z -t {target} || exit 1; fi; ")
}
fn action_command(action: &Action) -> Result<String, String> {
    if action.action == "create-session" {
        return Ok(format!(
            "unset TMUX; tmux new-session -d -s {} -x 120 -y 36",
            name(action.name.as_deref())?
        ));
    }
    let session = action.session.as_ref().ok_or("请选择会话")?;
    if !valid_id(&session.id, '$') {
        return Err("无效的会话 ID".into());
    }
    let sid = quote(&session.id);
    let target = action.target.as_deref().unwrap_or("");
    let mut guard = identity_guard(session);
    let cmd = match action.action.as_str() {
        "rename-session" => format!("rename-session -t {sid} {}", name(action.name.as_deref())?),
        "enable-mouse" => format!("set-option -t {sid} mouse on"),
        "kill-session" => {
            // tmux 3.4 may crash its server when the last session is killed while zoomed.
            // Restore only this session's zoomed windows before ending it.
            guard.push_str(&format!("tmux list-windows -t {sid} -F '#{{?window_zoomed_flag,#{{window_id}},}}' | while IFS= read -r window; do [ -z \"$window\" ] || tmux resize-pane -Z -t \"$window\" || exit 1; done || exit 1; "));
            format!("kill-session -t {sid}")
        }
        "new-window" => format!(
            "new-window -d -t {sid} -n {}",
            name(action.name.as_deref())?
        ),
        "select-window" | "rename-window" | "kill-window" => {
            if !valid_id(target, '@') {
                return Err("无效的窗口 ID".into());
            }
            // Window IDs can be linked into multiple sessions; use this session's exact window target.
            guard.push_str(&format!("tmux list-windows -t {sid} -F '#{{window_id}}' | grep -Fx -- {} >/dev/null || exit 1; ",quote(target)));
            let target = quote(&format!("{}:{}", session.id, target));
            if action.action == "kill-window" {
                guard.push_str(&unzoom_guard(&target));
            }
            match action.action.as_str() {
                "rename-window" => format!(
                    "rename-window -t {target} {}",
                    name(action.name.as_deref())?
                ),
                "select-window" => format!("select-window -t {target}"),
                _ => format!("kill-window -t {target}"),
            }
        }
        "split-horizontal" | "split-vertical" | "select-pane" | "zoom-pane" | "kill-pane"
        | "copy-mode" | "enable-passthrough" => {
            if !valid_id(target, '%') {
                return Err("无效的窗格 ID".into());
            }
            guard.push_str(&format!("tmux list-panes -s -t {sid} -F '#{{pane_id}}' | grep -Fx -- {} >/dev/null || exit 1; ",quote(target)));
            let target = quote(target);
            if action.action == "select-pane" || action.action == "copy-mode" {
                guard.push_str(&format!("window=$(tmux display-message -p -t {target} '#{{window_id}}') || exit 1; tmux select-window -t {}\"$window\" || exit 1; tmux select-pane -t {target} || exit 1; ", quote(&format!("{}:", session.id))));
            }
            if action.action == "kill-pane" {
                guard.push_str(&unzoom_guard(&target));
            }
            match action.action.as_str() {
                "split-horizontal" => format!("split-window -d -h -t {target}"),
                "split-vertical" => format!("split-window -d -v -t {target}"),
                "select-pane" => format!("select-pane -t {target}"),
                "copy-mode" => format!("copy-mode -t {target}"),
                "enable-passthrough" => format!("set-option -p -t {target} allow-passthrough on"),
                "zoom-pane" => format!("resize-pane -Z -t {target}"),
                _ => format!("kill-pane -t {target}"),
            }
        }
        _ => return Err("不支持的 tmux 操作".into()),
    };
    Ok(format!("unset TMUX; {guard} tmux {cmd}"))
}
#[tauri::command]
pub async fn tmux_action(
    ssh: State<'_, SshState>,
    session_id: String,
    request: Action,
) -> Result<(), String> {
    let command = action_command(&request)?;
    let handle = ssh.get_handle(&session_id).await.ok_or("SSH 连接已断开")?;
    execute(&handle, &command).await.map(|_| ())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn escapes_shell_names() {
        assert_eq!(quote("a'b; $(id)"), "'a'\"'\"'b; $(id)'");
        assert!(name(Some("bad\nname")).is_err());
    }
    #[test]
    fn rejects_invalid_targets() {
        let target = Target {
            id: "$0;touch /tmp/bad".into(),
            created: 1,
        };
        assert!(attach_command(&target).is_err());
    }
    #[test]
    fn attach_preserves_other_clients_and_checks_identity() {
        let cmd = attach_command(&Target {
            id: "$1".into(),
            created: 42,
        })
        .unwrap();
        assert!(cmd.contains("session_created"));
        assert!(cmd.contains("attach-session -t '$1'"));
        assert!(!cmd.contains("attach-session -d"));
    }
    #[test]
    fn parses_sessions_and_panes() {
        let s=parse_snapshot(&"DSSH_TMUX_VERSION\ntmux 3.4\nDSSH_TMUX_SESSIONS\n$0\twork\t1\t0\t123\nDSSH_TMUX_PANES\n$0\t@0\t0\teditor\t1\t%0\t0\t1\tnvim\t/home/user\t0\n".replace("\t", SEPARATOR)).unwrap();
        assert_eq!(s.sessions[0].created, 123);
        assert_eq!(s.panes[0].command, "nvim");
    }
    #[test]
    fn empty_and_missing_servers_are_distinct() {
        assert!(!parse_snapshot("DSSH_TMUX_MISSING\n").unwrap().installed);
        assert!(parse_snapshot(
            "DSSH_TMUX_VERSION\ntmux 3.4\nDSSH_TMUX_SESSIONS\nDSSH_TMUX_PANES\n"
        )
        .unwrap()
        .sessions
        .is_empty());
        assert!(parse_snapshot("garbage").is_err());
    }
    #[test]
    fn requires_scope_and_whitelisted_action() {
        let mut a = Action {
            action: "kill-pane".into(),
            session: Some(Target {
                id: "$0".into(),
                created: 1,
            }),
            target: Some("%3".into()),
            name: None,
        };
        assert!(action_command(&a).unwrap().contains("list-panes -s"));
        a.action = "kill-server".into();
        assert!(action_command(&a).is_err());
    }
}

#[cfg(all(test, target_os = "windows"))]
mod live_tests {
    use super::*;
    use std::process::Command;
    struct Sandbox(String);
    impl Sandbox {
        fn run(&self, command: &str) -> Result<String, String> {
            // Model zsh's read-only `status` parameter so the lifecycle test
            // catches shell-variable collisions even when WSL uses POSIX sh.
            let script = format!(
                "readonly status=0; tmux() {{ command tmux -f /dev/null -L {} \"$@\"; }}; {}",
                quote(&self.0),
                command
            );
            use std::io::Write;
            use std::process::Stdio;
            let mut child = Command::new("wsl")
                .args(["-d", "Ubuntu", "--", "sh", "-s"])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(script.as_bytes())
                .map_err(|e| e.to_string())?;
            let out = child.wait_with_output().map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).into_owned());
            }
            if !out.stderr.is_empty() {
                eprintln!("WSL stderr: {}", String::from_utf8_lossy(&out.stderr));
            }
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        }
        fn snapshot(&self) -> Snapshot {
            {
                let raw = self.run(&SNAPSHOT.replace("\\t", SEPARATOR)).unwrap();
                parse_snapshot(&raw).unwrap_or_else(|e| panic!("{e}: {raw:?}"))
            }
        }
    }
    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = self.run("tmux kill-server");
        }
    }
    #[test]
    #[ignore = "requires WSL Ubuntu with tmux; uses an isolated socket"]
    fn tmux_live_session_window_pane_lifecycle() {
        let sandbox = Sandbox(format!(
            "dssh-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        assert!(sandbox.snapshot().sessions.is_empty());
        let mut action = Action {
            action: "create-session".into(),
            session: None,
            target: None,
            name: Some("test space ' quote".into()),
        };
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        let snapshot = sandbox.snapshot();
        assert_eq!(snapshot.sessions.len(), 1);
        let session = &snapshot.sessions[0];
        action.session = Some(Target {
            id: session.id.clone(),
            created: session.created,
        });
        action.action = "new-window".into();
        action.name = Some("editor".into());
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        let snapshot2 = sandbox.snapshot();
        assert_eq!(snapshot2.sessions[0].windows, 2);
        let pane = snapshot2
            .panes
            .iter()
            .find(|p| p.window_name == "editor")
            .unwrap();
        action.target = Some(pane.window_id.clone());
        action.action = "select-window".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        assert!(sandbox
            .snapshot()
            .panes
            .iter()
            .any(|p| p.window_name == "editor" && p.window_active));
        action.target = Some(pane.id.clone());
        action.action = "split-horizontal".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        assert_eq!(sandbox.snapshot().panes.len(), 3);
        action.action = "zoom-pane".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        assert!(sandbox.snapshot().panes.iter().any(|p| p.zoomed));
        action.target = Some(snapshot.panes[0].id.clone());
        action.action = "select-pane".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        assert!(sandbox
            .snapshot()
            .panes
            .iter()
            .any(|p| p.id == snapshot.panes[0].id && p.window_active && p.active));
        action.action = "enable-mouse".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        action.action = "enable-passthrough".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        action.action = "rename-session".into();
        action.name = Some("renamed".into());
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        assert_eq!(sandbox.snapshot().sessions[0].name, "renamed");
        let wrong = Target {
            id: session.id.clone(),
            created: session.created + 1,
        };
        assert!(sandbox
            .run(&format!("{} true", identity_guard(&wrong)))
            .is_err());
        action.action = "kill-session".into();
        sandbox.run(&action_command(&action).unwrap()).unwrap();
        assert!(sandbox.snapshot().sessions.is_empty());
    }
}

/// Explicit user action: fetch the latest buffer from this SSH user's default tmux server.
#[tauri::command]
pub async fn tmux_copy_buffer(ssh: State<'_, SshState>, session_id: String) -> Result<String, String> {
    let handle = ssh.get_handle(&session_id).await.ok_or("SSH 连接已断开")?;
    execute(&handle, "unset TMUX; tmux save-buffer -").await.map_err(|_| "未能读取 tmux 复制内容，请先在 tmux 中选择并复制文字".into())
}
