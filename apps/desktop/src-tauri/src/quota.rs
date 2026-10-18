//! Read-only model quota lookup: runs the amail `quota.sh --json` on the connected server.
//!
//! The remote command is fixed — no part of it comes from the frontend — so this cannot be
//! used to run anything else. stderr is discarded on the server and never returned, because
//! quota.sh error output may mention credential paths or accounts.
use crate::{local_shell::LocalState, ssh::SshState};
use serde::Serialize;
use std::time::Duration;
use tauri::State;

/// Seconds quota.sh may run on the server before `timeout` kills it.
const REMOTE_LIMIT: u64 = 75;
const BODY_LIMIT: usize = 512 * 1024;

pub(crate) const QUOTA_COMMAND: &str = concat!(
    "f=\"$HOME/.amail/client/scripts/quota.sh\"; ",
    "if [ ! -r \"$f\" ]; then echo DSSH_QUOTA_MISSING; exit 0; fi; ",
    "if ! command -v python3 >/dev/null 2>&1; then echo DSSH_QUOTA_NO_PYTHON; exit 0; fi; ",
    "if command -v timeout >/dev/null 2>&1; then ",
    "out=$(timeout -k 5 75 bash \"$f\" --json 2>/dev/null </dev/null); ",
    "else out=$(bash \"$f\" --json 2>/dev/null </dev/null); fi; ",
    "rc=$?; echo \"DSSH_QUOTA_RC $rc\"; printf '%s\\n' \"$out\"; exit 0"
);

#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum QuotaResult {
    /// quota.sh printed JSON; the frontend parses and validates it.
    Ok { body: String },
    /// `~/.amail/client/scripts/quota.sh` is not on the server.
    Missing,
    /// The script exists but did not produce JSON.
    Failed { message: String },
}

/// Interpret the marker-framed output of [`QUOTA_COMMAND`]. Never echoes raw output.
pub(crate) fn parse_output(text: &str) -> QuotaResult {
    let text = text.trim_start();
    if text.starts_with("DSSH_QUOTA_MISSING") {
        return QuotaResult::Missing;
    }
    if text.starts_with("DSSH_QUOTA_NO_PYTHON") {
        return QuotaResult::Failed { message: "服务器缺少 python3，quota.sh 无法运行".into() };
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
            124 | 137 => format!("quota.sh 超过 {REMOTE_LIMIT} 秒未返回，已终止"),
            0 => "quota.sh 没有输出 JSON".into(),
            _ => format!("quota.sh 运行失败（退出码 {code}）"),
        },
    }
}

#[tauri::command]
pub async fn quota_fetch(
    ssh: State<'_, SshState>,
    local: State<'_, LocalState>,
    session_id: String,
) -> Result<QuotaResult, String> {
    if session_id.is_empty() {
        return Err("未连接服务器".into());
    }
    if session_id.starts_with("local-") {
        return Err("本地终端不支持额度查询".into());
    }
    let output = crate::tmux::execute_session(
        &ssh,
        &local,
        &session_id,
        QUOTA_COMMAND,
        Duration::from_secs(REMOTE_LIMIT + 15),
    )
    .await
    // execute_session errors carry remote stderr; keep only our own wording.
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
        assert!(QUOTA_COMMAND.contains("quota.sh\"; "));
        assert!(QUOTA_COMMAND.contains("--json 2>/dev/null"));
        assert!(QUOTA_COMMAND.contains("timeout -k 5 75"));
        assert!(QUOTA_COMMAND.ends_with("exit 0"));
    }

    #[test]
    fn markers_map_to_results() {
        assert_eq!(parse_output("DSSH_QUOTA_MISSING\n"), QuotaResult::Missing);
        assert!(matches!(parse_output("DSSH_QUOTA_NO_PYTHON\n"), QuotaResult::Failed { .. }));
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
    fn command_runs_against_fake_home() {
        // Exercise the real shell text: a missing script, then a stub quota.sh.
        let home = std::env::temp_dir().join(format!("dssh-quota-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        std::fs::create_dir_all(&home).unwrap();
        let run = || {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(QUOTA_COMMAND)
                .env("HOME", &home)
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap()
        };
        assert_eq!(parse_output(&run()), QuotaResult::Missing);
        let dir = home.join(".amail/client/scripts");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("quota.sh"), "echo secret-on-stderr >&2\necho '{\"meta\":{},\"channels\":{}}'\n").unwrap();
        assert_eq!(parse_output(&run()), QuotaResult::Ok { body: "{\"meta\":{},\"channels\":{}}".into() });
        std::fs::write(dir.join("quota.sh"), "echo leaked >&2\nexit 3\n").unwrap();
        let out = run();
        assert!(!out.contains("leaked"));
        assert!(matches!(parse_output(&out), QuotaResult::Failed { .. }));
        let _ = std::fs::remove_dir_all(&home);
    }
}
