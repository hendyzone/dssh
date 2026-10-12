//! Read the optional pane_ps_* tmux extension without altering the tmux server.
use crate::{local_shell::LocalState, ssh::SshState, tmux::execute_session};
use std::{collections::HashSet, time::Duration};
use tauri::State;

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_PANES: usize = 512;
const MAX_FIELD_BYTES: usize = 4096;
const HEADER: &str = "DSSH_TMUX_PS_V1\n";
const UNSUPPORTED: &str = "DSSH_TMUX_PS_UNSUPPORTED\n";

/// The format is fixed data: no eval, shell interpolation, or recursive tmux E/T
/// expansion of program-supplied values. `n:` is tmux's UTF-8 byte length, so
/// netstrings safely frame even session names containing newlines or delimiters.
/// `-u` preserves those UTF-8 bytes; `-N` forbids starting a missing server.
pub(crate) const PRODUCTION_COMMAND: &str = r#"unset TMUX
export LC_ALL=C
if ! command -v tmux >/dev/null 2>&1; then
  printf 'DSSH_TMUX_PS_UNSUPPORTED\n'
  exit 0
fi
if ! tmux -N show-hooks -g pane-status-changed >/dev/null 2>&1; then
  printf 'DSSH_TMUX_PS_UNSUPPORTED\n'
  exit 0
fi
printf 'DSSH_TMUX_PS_V1\n'
tmux -N -u list-panes -a -F '#{n:session_id}:#{session_id},#{n:session_created}:#{session_created},#{n:session_name}:#{session_name},#{n:pane_id}:#{pane_id},#{n:window_id}:#{window_id},#{n:window_active}:#{window_active},#{n:pane_active}:#{pane_active},#{n:pane_ps_state}:#{pane_ps_state},#{n:pane_ps_kind}:#{pane_ps_kind},#{n:pane_ps_progress}:#{pane_ps_progress},#{n:pane_ps_app}:#{pane_ps_app},#{n:pane_ps_title}:#{pane_ps_title},#{n:pane_ps_msg}:#{pane_ps_msg}'
"#;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramPane {
    pub session_id: String,
    pub session_created: u64,
    pub session_name: String,
    pub pane_id: String,
    pub window_id: String,
    pub window_active: bool,
    pub pane_active: bool,
    pub state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct ProgramSnapshot {
    pub supported: bool,
    pub panes: Vec<ProgramPane>,
}

fn invalid() -> String {
    "tmux 程序状态响应无效".into()
}

fn take_field<'a>(input: &mut &'a str, last: bool) -> Result<&'a str, String> {
    let separator = input.find(':').ok_or_else(invalid)?;
    let size = &input[..separator];
    if size.is_empty() || size.len() > 4 || !size.bytes().all(|b| b.is_ascii_digit()) {
        return Err(invalid());
    }
    let size: usize = size.parse().map_err(|_| invalid())?;
    if size > MAX_FIELD_BYTES {
        return Err("tmux 程序状态字段超过限制".into());
    }
    let rest = &input[separator + 1..];
    let value = rest.get(..size).ok_or_else(invalid)?;
    let remaining = rest.get(size..).ok_or_else(invalid)?;
    let delimiter = if last { '\n' } else { ',' };
    *input = remaining.strip_prefix(delimiter).ok_or_else(invalid)?;
    Ok(value)
}

fn valid_id(value: &str, prefix: u8) -> bool {
    let bytes = value.as_bytes();
    bytes.len() > 1
        && bytes.len() <= 21
        && bytes[0] == prefix
        && bytes[1..].iter().all(u8::is_ascii_digit)
}

fn boolean(value: &str) -> Result<bool, String> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(invalid()),
    }
}

fn optional_text(value: &str, limit: usize) -> Result<Option<String>, String> {
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok((!value.is_empty()).then(|| value.into()))
}

/// Reject malformed snapshots atomically: incomplete polls must not clear tasks.
pub(crate) fn parse_snapshot(text: &str) -> Result<ProgramSnapshot, String> {
    if text.len() > MAX_OUTPUT_BYTES {
        return Err("tmux 程序状态输出超过限制".into());
    }
    if text == UNSUPPORTED {
        return Ok(ProgramSnapshot {
            supported: false,
            panes: vec![],
        });
    }
    let mut input = text.strip_prefix(HEADER).ok_or_else(invalid)?;
    let mut panes = Vec::new();
    let mut identities = HashSet::new();
    while !input.is_empty() {
        if panes.len() == MAX_PANES {
            return Err("tmux 窗格数量超过限制".into());
        }
        let mut fields = Vec::with_capacity(13);
        for index in 0..13 {
            fields.push(take_field(&mut input, index == 12)?);
        }
        let f = fields;
        if !valid_id(f[0], b'$')
            || !valid_id(f[3], b'%')
            || !valid_id(f[4], b'@')
            || f[1].is_empty()
            || f[1].len() > 16
            || !f[1].bytes().all(|b| b.is_ascii_digit())
            || f[2].is_empty()
            || f[2].len() > 1024
            || f[2].contains('\0')
        {
            return Err(invalid());
        }
        let session_created: u64 = f[1].parse().map_err(|_| invalid())?;
        // JavaScript receives this number and uses it for stale-identity checks.
        if session_created > 9_007_199_254_740_991 {
            return Err(invalid());
        }
        if !identities.insert((f[0].to_owned(), session_created, f[3].to_owned())) {
            return Err("tmux 程序状态包含重复窗格".into());
        }
        let state = match f[7] {
            "" => None,
            "idle" | "working" | "blocked" | "done" | "error" => Some(f[7].to_owned()),
            _ => return Err(invalid()),
        };
        let kind = match f[8] {
            "" => None,
            "permission" | "question" | "auth" => Some(f[8].to_owned()),
            _ => return Err(invalid()),
        };
        let progress = if f[9].is_empty() {
            None
        } else {
            if !f[9].bytes().all(|b| b.is_ascii_digit()) {
                return Err(invalid());
            }
            let value: u8 = f[9].parse().map_err(|_| invalid())?;
            if value > 100 {
                return Err(invalid());
            }
            Some(value)
        };
        let app = optional_text(f[10], 32)?;
        if !f[10]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.+-".contains(&b))
        {
            return Err(invalid());
        }
        let title = optional_text(f[11], 192)?;
        let msg = optional_text(f[12], 2048)?;
        let has_state = state.is_some();
        let blocked = state.as_deref() == Some("blocked");
        let progressing = blocked || state.as_deref() == Some("working");
        panes.push(ProgramPane {
            session_id: f[0].into(),
            session_created,
            session_name: f[2].into(),
            pane_id: f[3].into(),
            window_id: f[4].into(),
            window_active: boolean(f[5])?,
            pane_active: boolean(f[6])?,
            state,
            kind: if blocked { kind } else { None },
            progress: if progressing { progress } else { None },
            app: if has_state { app } else { None },
            title: if has_state { title } else { None },
            msg: if has_state { msg } else { None },
        });
    }
    Ok(ProgramSnapshot {
        supported: true,
        panes,
    })
}

#[tauri::command]
pub async fn tmux_program_status(
    ssh: State<'_, SshState>,
    local: State<'_, LocalState>,
    session_id: String,
) -> Result<ProgramSnapshot, String> {
    // Windows native local PTYs do not provide the POSIX tmux control backend.
    if cfg!(windows) && session_id.starts_with("local-") {
        return Ok(ProgramSnapshot {
            supported: false,
            panes: vec![],
        });
    }
    let text = execute_session(
        &ssh,
        &local,
        &session_id,
        PRODUCTION_COMMAND,
        Duration::from_secs(12),
    )
    .await?;
    parse_snapshot(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(fields: &[&str]) -> String {
        let values = fields
            .iter()
            .map(|value| format!("{}:{}", value.len(), value))
            .collect::<Vec<_>>();
        format!("{}\n", values.join(","))
    }

    fn normal() -> Vec<&'static str> {
        vec![
            "$0",
            "123",
            "work",
            "%1",
            "@2",
            "1",
            "0",
            "working",
            "",
            "40",
            "cargo",
            "Build",
            "Compiling",
        ]
    }

    fn parse_fields(fields: &[&str]) -> Result<ProgramSnapshot, String> {
        parse_snapshot(&format!("{HEADER}{}", row(fields)))
    }

    #[test]
    fn preserves_pane_identity_progress_and_null_state_focus_rows() {
        let first = normal();
        let second = vec![
            "$0", "123", "work", "%2", "@2", "1", "1", "", "", "", "", "", "",
        ];
        let snapshot = parse_snapshot(&format!("{HEADER}{}{}", row(&first), row(&second))).unwrap();
        assert!(snapshot.supported);
        assert_eq!(snapshot.panes.len(), 2);
        assert_eq!(snapshot.panes[0].state.as_deref(), Some("working"));
        assert_eq!(snapshot.panes[0].progress, Some(40));
        assert!(!snapshot.panes[0].pane_active);
        assert_eq!(snapshot.panes[1].state, None);
        assert!(snapshot.panes[1].pane_active);
        let json = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(json["panes"][0]["sessionCreated"], 123);
        assert_eq!(json["panes"][1]["state"], serde_json::Value::Null);
        assert!(json["panes"][1].get("progress").is_none());
    }

    #[test]
    fn preserves_utf8_and_delimiters_as_data_without_interpreting_format_or_shell_text() {
        let mut fields = normal();
        fields[2] = "会话\n0:,\t|DSSH-TMUX| '#(touch /tmp/no)' ${HOME}";
        fields[11] = "中文 :,#{} ' \" \\";
        fields[12] = "$(touch /tmp/no); #{pane_id} #(not-a-job) |DSSH-TMUX|";
        let snapshot = parse_fields(&fields).unwrap();
        assert_eq!(snapshot.panes[0].session_name, fields[2]);
        assert_eq!(snapshot.panes[0].title.as_deref(), Some(fields[11]));
        assert_eq!(snapshot.panes[0].msg.as_deref(), Some(fields[12]));
        assert!(!PRODUCTION_COMMAND.contains("eval"));
        assert!(!PRODUCTION_COMMAND.contains("#{E:"));
        assert!(!PRODUCTION_COMMAND.contains("#{T:"));
    }

    #[test]
    fn rejects_corrupt_lengths_delimiters_utf8_boundaries_and_truncated_polls() {
        let good = format!("{HEADER}{}", row(&normal()));
        for bad in [
            good.replacen("2:$0,", "x:$0,", 1),
            good.replacen("2:$0,", "2:$0;", 1),
            format!("{HEADER}1:中,{}", row(&normal())),
            good[..good.len() - 1].to_owned(),
            format!("{good}unexpected"),
            format!("{HEADER}99999:x,"),
            format!("{HEADER}4097:x,"),
        ] {
            assert!(parse_snapshot(&bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn validates_ids_fields_and_protocol_bounds_atomically() {
        for (index, value) in [
            (0, "$0;touch x"),
            (1, "9007199254740992"),
            (3, "%1\n"),
            (4, "window"),
            (5, "yes"),
            (6, "2"),
            (7, "clear"),
            (8, "future"),
            (9, "101"),
            (9, "1.0"),
            (10, "bad/app"),
            (11, "title\t"),
            (12, "line\n"),
            (12, "line\u{7f}"),
            (12, "line\u{80}"),
            (12, "line\u{9f}"),
        ] {
            let mut fields = normal();
            fields[index] = value;
            assert!(
                parse_fields(&fields).is_err(),
                "accepted field {index}: {value:?}"
            );
        }
        for (index, size) in [(2, 1025), (10, 33), (11, 193), (12, 2049)] {
            let oversized = "x".repeat(size);
            let mut fields = normal();
            fields[index] = &oversized;
            assert!(parse_fields(&fields).is_err());
        }
    }

    #[test]
    fn supports_empty_or_missing_servers_without_claiming_protocol_support() {
        assert!(!parse_snapshot(UNSUPPORTED).unwrap().supported);
        let empty = parse_snapshot(HEADER).unwrap();
        assert!(empty.supported && empty.panes.is_empty());
        assert!(parse_snapshot("garbage\n").is_err());
        assert!(parse_snapshot(&format!("{UNSUPPORTED}garbage")).is_err());
        assert!(PRODUCTION_COMMAND.contains("tmux -N show-hooks -g pane-status-changed"));
        assert!(PRODUCTION_COMMAND.contains("tmux -N -u list-panes -a"));
        assert!(!PRODUCTION_COMMAND.contains("tmux -V"));
        assert!(!PRODUCTION_COMMAND.contains("new-session"));
    }

    #[test]
    fn rejects_duplicate_identities_and_bounds_the_complete_snapshot() {
        let one = row(&normal());
        assert!(parse_snapshot(&format!("{HEADER}{one}{one}")).is_err());
        let mut text = HEADER.to_owned();
        for index in 0..MAX_PANES {
            let pane_id = format!("%{index}");
            let mut fields = normal();
            fields[3] = &pane_id;
            text.push_str(&row(&fields));
        }
        assert_eq!(parse_snapshot(&text).unwrap().panes.len(), MAX_PANES);
        text.push_str(&one);
        assert!(parse_snapshot(&text).is_err());
        assert!(parse_snapshot(&"x".repeat(MAX_OUTPUT_BYTES + 1)).is_err());
    }

    #[test]
    fn preserves_multiple_sessions_linking_the_same_pane_and_normalizes_optional_state_fields() {
        let mut first = normal();
        first[7] = "blocked";
        first[8] = "permission";
        let mut second = first.clone();
        second[0] = "$1";
        second[1] = "456";
        second[7] = "done";
        let snapshot = parse_snapshot(&format!("{HEADER}{}{}", row(&first), row(&second))).unwrap();
        assert_eq!(snapshot.panes[0].kind.as_deref(), Some("permission"));
        assert_eq!(snapshot.panes[1].kind, None);
        assert_eq!(snapshot.panes[1].progress, None);
    }

    #[test]
    fn replays_real_patched_tmux_output_with_utf8_lengths_and_untrusted_text() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/tmux-pane-ps-3.7c.json"
        )))
        .unwrap();
        assert_eq!(fixture["tmuxVersion"], "tmux 3.7c");
        let snapshot = parse_snapshot(fixture["raw"].as_str().unwrap()).unwrap();
        assert!(snapshot.supported);
        let expected = &fixture["expected"];
        let pane = snapshot
            .panes
            .iter()
            .find(|pane| pane.pane_id == expected["pane_id"].as_str().unwrap())
            .unwrap();
        assert_eq!(pane.session_id, expected["session_id"].as_str().unwrap());
        assert_eq!(
            pane.session_created.to_string(),
            expected["session_created"].as_str().unwrap()
        );
        assert_eq!(
            pane.session_name,
            expected["session_name"].as_str().unwrap()
        );
        assert_eq!(pane.window_id, expected["window_id"].as_str().unwrap());
        assert_eq!(pane.window_active, expected["window_active"] == "1");
        assert_eq!(pane.pane_active, expected["pane_active"] == "1");
        assert_eq!(pane.state.as_deref(), expected["state"].as_str());
        assert_eq!(pane.kind.as_deref(), expected["kind"].as_str());
        assert_eq!(
            pane.progress.unwrap().to_string(),
            expected["progress"].as_str().unwrap()
        );
        assert_eq!(pane.app.as_deref(), expected["app"].as_str());
        assert_eq!(pane.title.as_deref(), expected["title"].as_str());
        assert_eq!(pane.msg.as_deref(), expected["msg"].as_str());
        // tmux itself rejects control characters in session names; arbitrary
        // newline/tab framing is covered by the synthetic parser test above.
        assert!(pane.session_name.contains("中文"));
        assert!(pane.session_name.contains("|DSSH-TMUX|"));
        assert!(pane.msg.as_ref().unwrap().contains("中文"));
        assert!(pane.msg.as_ref().unwrap().contains("#{pane_id}"));
        assert!(snapshot.panes.iter().any(|pane| pane.state.is_none()));
    }
}
