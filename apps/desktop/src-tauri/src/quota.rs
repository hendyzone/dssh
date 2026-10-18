//! Read-only model quota lookup: streams the bundled `model-quota.py` to the connected server over
//! SSH stdin and runs it with `python3 - --json`. The server only needs python3.
//!
//! The remote command and the script are fixed at build time — no part of them comes from the
//! frontend — so this cannot be used to run anything else. stderr is discarded on the server and
//! never returned, because error output may mention credential paths or accounts.
use crate::ssh::SshState;
use serde::Serialize;
use std::time::Duration;
use tauri::State;

/// The public quota script (canonical copy: `tools/model-quota/model-quota.py` in this repo).
pub(crate) const QUOTA_SCRIPT: &str = include_str!("../../../../tools/model-quota/model-quota.py");

/// Seconds the script may run on the server before `timeout` kills it.
const REMOTE_LIMIT: u64 = 75;
const BODY_LIMIT: usize = 512 * 1024;

pub(crate) const QUOTA_COMMAND: &str = concat!(
    "if ! command -v python3 >/dev/null 2>&1; then echo DSSH_QUOTA_NO_PYTHON; exit 0; fi; ",
    "if command -v timeout >/dev/null 2>&1; then ",
    "out=$(timeout -k 5 75 python3 - --json 2>/dev/null); ",
    "else out=$(python3 - --json 2>/dev/null); fi; ",
    "rc=$?; echo \"DSSH_QUOTA_RC $rc\"; printf '%s\\n' \"$out\"; exit 0"
);

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuotaResult {
    /// The script printed JSON; the frontend parses and validates it.
    Ok { body: String },
    /// The server has no `python3`.
    NoPython,
    /// The script ran but did not produce JSON.
    Failed { message: String },
}

/// Interpret the marker-framed output of [`QUOTA_COMMAND`]. Never echoes raw output.
pub(crate) fn parse_output(text: &str) -> QuotaResult {
    let text = text.trim_start();
    if text.starts_with("DSSH_QUOTA_NO_PYTHON") {
        return QuotaResult::NoPython;
    }
    let Some(rest) = text.strip_prefix("DSSH_QUOTA_RC ") else {
        return QuotaResult::Failed { message: "额度查询返回格式无效".into() };
    };
    let (code, body) = rest.split_once('\n').unwrap_or((rest, ""));
    let code: i32 = code.trim().parse().unwrap_or(-1);
    let body = body.trim();
    if code == 0 && body.starts_with('{') {
        if body.len() > BODY_LIMIT {
            return QuotaResult::Failed { message: "额度查询输出超过限制".into() };
        }
        return QuotaResult::Ok { body: body.into() };
    }
    QuotaResult::Failed {
        message: match code {
            124 | 137 => format!("额度脚本超过 {REMOTE_LIMIT} 秒未返回，已终止"),
            0 => "额度脚本没有输出 JSON".into(),
            _ => format!("额度脚本运行失败（退出码 {code}，python3 版本过旧？需要 3.8+）"),
        },
    }
}

#[tauri::command]
pub async fn quota_fetch(ssh: State<'_, SshState>, session_id: String) -> Result<QuotaResult, String> {
    if session_id.is_empty() {
        return Err("未连接服务器".into());
    }
    if session_id.starts_with("local-") {
        return Err("本地终端不支持额度查询".into());
    }
    let output = crate::tmux::execute_session_with_input(
        &ssh,
        &session_id,
        QUOTA_COMMAND,
        QUOTA_SCRIPT.as_bytes(),
        Duration::from_secs(REMOTE_LIMIT + 15),
    )
    .await
    // execute errors carry remote stderr; keep only our own wording.
    .map_err(|e| {
        if e.contains("超时") {
            "额度查询超时".to_string()
        } else if e.contains("断开") {
            "终端连接已断开".to_string()
        } else {
            "额度查询失败：无法在服务器上执行".to_string()
        }
    })?;
    Ok(parse_output(&output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_is_fixed_and_discards_stderr() {
        assert!(QUOTA_COMMAND.contains("python3 - --json 2>/dev/null)"));
        assert!(QUOTA_COMMAND.contains("timeout -k 5 75"));
        assert!(QUOTA_COMMAND.ends_with("exit 0"));
        assert!(!QUOTA_COMMAND.contains(".amail"));
    }

    #[test]
    fn script_is_embedded_and_self_contained() {
        assert!(QUOTA_SCRIPT.starts_with("#!/usr/bin/env python3"));
        assert!(QUOTA_SCRIPT.contains("def main("));
        // Only public vendor endpoints are compiled in: no relay address, no private host.
        const PUBLIC: [&str; 5] = ["api.kimi.com", "api.deepseek.com", "api.anthropic.com", "chatgpt.com", "cursor.com"];
        for url in QUOTA_SCRIPT.split("https://").skip(1) {
            let host: String = url.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-').collect();
            assert!(PUBLIC.contains(&host.as_str()) || host == "relay.example.com", "unexpected host {host}");
        }
    }

    #[test]
    fn markers_map_to_results() {
        assert_eq!(parse_output("DSSH_QUOTA_NO_PYTHON\n"), QuotaResult::NoPython);
        assert_eq!(
            parse_output("DSSH_QUOTA_RC 0\n{\"meta\":{},\"channels\":{}}\n"),
            QuotaResult::Ok { body: "{\"meta\":{},\"channels\":{}}".into() }
        );
    }

    #[test]
    fn failures_never_echo_output() {
        let secret = "DSSH_QUOTA_RC 1\nTraceback: token sk-abcdefghijklmnop at /home/u/.codex/auth.json";
        match parse_output(secret) {
            QuotaResult::Failed { message } => {
                assert!(!message.contains("sk-"));
                assert!(message.contains("退出码 1"));
            }
            other => panic!("{other:?}"),
        }
        match parse_output("DSSH_QUOTA_RC 124\n") {
            QuotaResult::Failed { message } => assert!(message.contains("75 秒")),
            other => panic!("{other:?}"),
        }
        assert!(matches!(parse_output("DSSH_QUOTA_RC 0\nnot json"), QuotaResult::Failed { .. }));
        assert!(matches!(parse_output("garbage"), QuotaResult::Failed { .. }));
        let huge = format!("DSSH_QUOTA_RC 0\n{{{}}}", "x".repeat(BODY_LIMIT));
        assert!(matches!(parse_output(&huge), QuotaResult::Failed { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn command_runs_embedded_script_from_stdin() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        // Exercise the real shell text with the real script on an empty HOME: every channel
        // reports missing credentials, and nothing reaches stdout besides the framed JSON.
        let home = std::env::temp_dir().join(format!("dssh-quota-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let has_python = Command::new("sh").arg("-c").arg("command -v python3").output().unwrap().status.success();
        let mut child = Command::new("sh")
            .arg("-c")
            .arg(QUOTA_COMMAND)
            .env("HOME", &home)
            .env_remove("HTTPS_PROXY")
            .env_remove("https_proxy")
            .env("PATH", "/usr/bin:/bin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(QUOTA_SCRIPT.as_bytes()).unwrap();
        let out = child.wait_with_output().unwrap();
        let stdout = String::from_utf8(out.stdout).unwrap();
        let _ = std::fs::remove_dir_all(&home);
        if !has_python {
            assert_eq!(parse_output(&stdout), QuotaResult::NoPython);
            return;
        }
        let QuotaResult::Ok { body } = parse_output(&stdout) else { panic!("{stdout}") };
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let channels = json["channels"].as_object().unwrap();
        for name in ["tokenline", "kimi", "deepseek", "claude", "codex", "pi-codex", "cursor", "agy"] {
            assert_eq!(channels[name]["ok"], false, "{name}");
        }
        assert_eq!(channels["claude"]["code"], "no_credentials");
        assert_eq!(json["meta"]["proxy"], "none");
    }
}
