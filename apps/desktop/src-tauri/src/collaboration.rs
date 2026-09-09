//! Optional collaboration through separate SSH exec channels; no terminal injection.
use crate::{
    ssh::SshState,
    tmux::{execute_with_timeout, quote},
};
use serde::Deserialize;
use std::time::Duration;
use tauri::State;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Profile {
    enabled: bool,
    taskboard_enabled: bool,
    mail_enabled: bool,
    project: String,
    workdir: String,
    taskboard_url: String,
    taskboard_bin: String,
    token_file: String,
    python_bin: String,
    mailctl_path: String,
}

impl Default for Profile {
    fn default() -> Self {
        Self {
            enabled: false,
            taskboard_enabled: false,
            mail_enabled: false,
            project: String::new(),
            workdir: String::new(),
            taskboard_url: String::new(),
            taskboard_bin: "taskboard".into(),
            token_file: String::new(),
            python_bin: "python3".into(),
            mailctl_path: String::new(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Operation {
    Context,
    Inbox,
    Read,
    Send,
    Reply,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    operation: Operation,
    #[serde(default)]
    task: String,
    #[serde(default)]
    uid: String,
    #[serde(default)]
    to: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    body: String,
    #[serde(default = "preview_default")]
    preview: bool,
}
fn preview_default() -> bool {
    true
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn literal(value: &str) -> Result<String, String> {
    if value.trim().is_empty() || value.len() > 4096 || value.contains(['\0', '\r', '\n']) {
        return Err("配置必须为非空单行文本".into());
    }
    Ok(quote(value))
}
fn absolute_path(value: &str) -> Result<String, String> {
    if !value.starts_with('/') {
        return Err("请填写远端 POSIX 绝对路径".into());
    }
    literal(value)
}

fn build_command(profile: &Profile, request: &Request, session: &str) -> Result<String, String> {
    if !profile.enabled {
        return Err("Agent 协作未开启".into());
    }
    if !identifier(&profile.project) {
        return Err("项目编号格式无效".into());
    }
    let directory = absolute_path(&profile.workdir)?;
    let mut args: Vec<String>;
    let mut environment = vec![
        format!("TASKBOARD_PROJECT={}", quote(&profile.project)),
        format!("TASKBOARD_TASK={}", quote(&request.task)),
        format!("AMAIL_SESSION={}", literal(&format!("dssh-{session}"))?),
        format!("AGENT_MAIL_HOME={}", directory),
    ];
    if matches!(request.operation, Operation::Context) {
        if !profile.taskboard_enabled {
            return Err("任务看板未开启".into());
        }
        let url = reqwest::Url::parse(&profile.taskboard_url).map_err(|_| "看板 URL 无效")?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("看板地址须为 HTTP(S)，且不能含凭据、查询参数或片段".into());
        }
        environment.push(format!(
            "TASKBOARD_URL={}",
            literal(&profile.taskboard_url)?
        ));
        // Never inherit a different project's token from the remote shell.
        environment.push("TASKBOARD_TOKEN=''".into());
        environment.push(format!(
            "TASKBOARD_TOKEN_FILE={}",
            if profile.token_file.is_empty() {
                "''".into()
            } else {
                absolute_path(&profile.token_file)?
            }
        ));
        args = vec![
            literal(&profile.taskboard_bin)?,
            "agent".into(),
            "context".into(),
        ];
        if !request.task.is_empty() {
            if !identifier(&request.task) {
                return Err("任务编号格式无效".into());
            }
            args.extend(["--task".into(), quote(&request.task)]);
        }
    } else {
        if !profile.mail_enabled {
            return Err("Agent 通信未开启".into());
        }
        args = vec![
            literal(&profile.python_bin)?,
            absolute_path(&profile.mailctl_path)?,
        ];
        match request.operation {
            Operation::Inbox => args.extend(["inbox".into(), "--limit".into(), "20".into()]),
            Operation::Read | Operation::Reply => {
                if request.uid.is_empty()
                    || request.uid.len() > 20
                    || !request.uid.bytes().all(|b| b.is_ascii_digit())
                    || request.uid.starts_with('0')
                {
                    return Err("邮件 UID 必须为正整数".into());
                }
                args.extend([
                    "message".into(),
                    if matches!(request.operation, Operation::Read) {
                        "read".into()
                    } else {
                        "reply".into()
                    },
                    quote(&request.uid),
                ]);
            }
            Operation::Send => {
                if !identifier(&request.task) {
                    return Err("任务编号格式无效".into());
                }
                let recipients: Vec<_> = request.to.split(',').map(str::trim).collect();
                if recipients.is_empty()
                    || recipients.len() > 50
                    || recipients
                        .iter()
                        .any(|s| !s.contains('@') || s.chars().any(char::is_whitespace))
                {
                    return Err("请填写有效收件邮箱".into());
                }
                args.extend([
                    "message".into(),
                    "send".into(),
                    "--to".into(),
                    literal(&request.to)?,
                    "--project".into(),
                    quote(&profile.project),
                    "--task".into(),
                    quote(&request.task),
                ]);
            }
            Operation::Context => unreachable!(),
        }
        if matches!(request.operation, Operation::Send | Operation::Reply) {
            if ![
                "request", "ack", "progress", "blocked", "handoff", "result", "question", "answer",
            ]
            .contains(&request.kind.as_str())
            {
                return Err("消息类型无效".into());
            }
            if matches!(request.operation, Operation::Send)
                && ["ack", "answer"].contains(&request.kind.as_str())
            {
                return Err("回执和回答须回复已有邮件".into());
            }
            if request.body.trim().is_empty()
                || request.body.len() > 16384
                || request.body.contains('\0')
            {
                return Err("正文不能为空且不能超过 16 KiB".into());
            }
            args.extend([
                "--kind".into(),
                quote(&request.kind),
                "--body".into(),
                quote(&request.body),
            ]);
            if request.preview {
                args.push("--dry-run".into());
            }
        }
    }
    Ok(format!(
        "cd {} && env {} {}",
        directory,
        environment.join(" "),
        args.join(" ")
    ))
}

#[tauri::command]
pub async fn collaboration_request(
    ssh: State<'_, SshState>,
    session_id: String,
    profile: Profile,
    request: Request,
) -> Result<String, String> {
    let command = build_command(&profile, &request, &session_id)?;
    let handle = ssh
        .get_handle(&session_id)
        .await
        .ok_or("SSH 已断开，请先连接配置对应的服务器")?;
    execute_with_timeout(&handle, &command, Duration::from_secs(60))
        .await
        .map_err(|e| e.replace("tmux", "协作服务"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn profile() -> Profile {
        Profile {
            enabled: true,
            taskboard_enabled: true,
            mail_enabled: true,
            project: "demo".into(),
            workdir: "/repo with space".into(),
            taskboard_url: "https://board.example.test".into(),
            mailctl_path: "/srv/amail/client/mailctl.py".into(),
            ..Profile::default()
        }
    }
    fn request(op: Operation) -> Request {
        Request {
            operation: op,
            task: "T1".into(),
            uid: "42".into(),
            to: "pi@example.test".into(),
            kind: "request".into(),
            body: "hello".into(),
            preview: true,
        }
    }
    #[test]
    fn disabled_profiles_never_build_commands() {
        assert!(build_command(&Profile::default(), &request(Operation::Context), "s").is_err());
        let mut p = profile();
        p.mail_enabled = false;
        assert!(build_command(&p, &request(Operation::Send), "s").is_err());
        p.taskboard_enabled = false;
        assert!(build_command(&p, &request(Operation::Context), "s").is_err());
    }
    #[test]
    fn context_clears_inherited_credentials() {
        let command = build_command(&profile(), &request(Operation::Context), "s").unwrap();
        assert!(command.contains("TASKBOARD_TOKEN='' TASKBOARD_TOKEN_FILE=''"));
        assert!(command.ends_with("'taskboard' agent context --task 'T1'"));
    }
    #[test]
    fn message_is_quoted_and_defaults_to_preview() {
        let mut r = request(Operation::Send);
        r.body = "hello'\n$(touch /tmp/should-not-run)".into();
        let command = build_command(&profile(), &r, "s").unwrap();
        assert!(command.contains(&quote(&r.body)));
        assert!(command.ends_with("--dry-run"));
        r.preview = false;
        assert!(!build_command(&profile(), &r, "s")
            .unwrap()
            .ends_with("--dry-run"));
    }
    #[test]
    fn validation_blocks_invalid_paths_urls_and_uids() {
        let mut p = profile();
        p.workdir = "~/repo".into();
        assert!(build_command(&p, &request(Operation::Context), "s").is_err());
        p = profile();
        p.taskboard_url = "https://user:secret@host".into();
        assert!(build_command(&p, &request(Operation::Context), "s").is_err());
        let mut r = request(Operation::Read);
        r.uid = "1:*".into();
        assert!(build_command(&profile(), &r, "s").is_err());
        let r: Request = serde_json::from_str(r#"{"operation":"send"}"#).unwrap();
        assert!(r.preview);
    }
}
