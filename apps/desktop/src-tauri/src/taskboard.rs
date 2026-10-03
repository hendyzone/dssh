//! Read-only taskboard lookups: task cards, code index and status columns.
//!
//! Two explicit routes, never a silent fallback between them:
//! - `direct`: the desktop reaches the board URL configured under 设置 → 任务查询.
//! - `ssh`: the board URL saved in a tmux + worktree collaboration binding is reachable
//!   from that SSH server, so the GET runs there through a separate exec channel.
//! Only GET requests on a fixed set of read-only paths are possible.
use crate::{collaboration::Profile, local_shell::LocalState, ssh::SshState};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

/// Fields kept in the code index; enough for terminal hover cards and the task list.
pub(crate) const INDEX_FIELDS: [&str; 5] = ["code", "title", "status_key", "assignee", "updated_at"];
const BODY_LIMIT: usize = 16 * 1024 * 1024;

pub(crate) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}

/// Accept only the read-only endpoints this feature needs.
pub(crate) fn board_path(path: &str) -> Result<(), String> {
    let invalid = || "不支持的看板查询路径".to_string();
    let rest = path.strip_prefix("/api/v1/projects").ok_or_else(invalid)?;
    if rest.is_empty() {
        return Ok(());
    }
    let parts: Vec<&str> = rest.strip_prefix('/').ok_or_else(invalid)?.split('/').collect();
    let ok = match parts.as_slice() {
        [slug, "statuses"] | [slug, "tasks"] => identifier(slug),
        [slug, "tasks", code] | [slug, "tasks", code, "dependencies"] => {
            identifier(slug) && identifier(code)
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(invalid())
    }
}

pub(crate) fn board_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value.trim()).map_err(|_| "看板 URL 无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("看板地址须为 HTTP(S)，且不能含凭据、查询参数或片段".into());
    }
    Ok(url)
}

fn join(base: &reqwest::Url, path: &str) -> String {
    format!("{}{}", base.as_str().trim_end_matches('/'), path)
}

/// Reduce a task list to the index fields so a 1000+ task project stays small.
pub(crate) fn project_index(body: &str) -> Result<String, String> {
    let value: serde_json::Value = serde_json::from_str(body).map_err(|_| "看板返回格式无效")?;
    let tasks = value["tasks"].as_array().ok_or("看板返回格式无效")?;
    let reduced: Vec<serde_json::Value> = tasks
        .iter()
        .filter(|task| task["code"].is_string())
        .map(|task| {
            let mut entry = serde_json::Map::new();
            for field in INDEX_FIELDS {
                entry.insert(
                    field.into(),
                    task.get(field).cloned().unwrap_or(serde_json::Value::String(String::new())),
                );
            }
            serde_json::Value::Object(entry)
        })
        .collect();
    Ok(serde_json::json!({ "tasks": reduced }).to_string())
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Route {
    Direct { url: String },
    #[serde(rename_all = "camelCase")]
    Ssh { session_id: String, profile: Profile },
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct BoardResponse {
    pub status: u16,
    pub body: String,
}

async fn direct(url: &str, path: &str) -> Result<BoardResponse, String> {
    let target = join(&board_url(url)?, path);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化看板连接")?;
    let mut response = client
        .get(target)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                "看板不可达：连接超时".to_string()
            } else {
                "看板不可达：无法连接看板服务".to_string()
            }
        })?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "看板响应读取失败")? {
        if bytes.len() + chunk.len() > BODY_LIMIT {
            return Err("看板响应过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(BoardResponse {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    })
}

#[tauri::command]
pub async fn taskboard_get(
    ssh: State<'_, SshState>,
    local: State<'_, LocalState>,
    route: Route,
    path: String,
    index: bool,
) -> Result<BoardResponse, String> {
    board_path(&path)?;
    if index && !(path.ends_with("/tasks") && path.matches('/').count() == 5) {
        return Err("只有任务列表可以生成编号索引".into());
    }
    let mut response = match route {
        Route::Direct { url } => direct(&url, &path).await?,
        Route::Ssh { session_id, profile } => {
            let command = crate::collaboration::board_command(&profile, &path, index)?;
            let output = crate::tmux::execute_session(
                &ssh,
                &local,
                &session_id,
                &command,
                Duration::from_secs(30),
            )
            .await
            .map_err(|e| e.replace("tmux 操作失败：", "").replace("tmux", "看板查询"))?;
            serde_json::from_str::<BoardResponse>(output.trim())
                .map_err(|_| "远端看板查询返回格式无效".to_string())?
        }
    };
    if index && response.status == 200 {
        response.body = project_index(&response.body)?;
    }
    Ok(response)
}

/// Open the web board in the system browser. Only http(s) URLs without credentials.
#[tauri::command]
pub fn taskboard_open(url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "看板 URL 无效")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("只能打开 HTTP(S) 看板地址".into());
    }
    let url = parsed.to_string();
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("rundll32");
        c.args(["url.dll,FileProtocolHandler", url.as_str()]);
        c.creation_flags(0x0800_0000);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };
    let mut child = command.spawn().map_err(|e| format!("无法打开浏览器：{e}"))?;
    // Reap the launcher so it does not linger as a zombie.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_read_only_board_paths_are_allowed() {
        for ok in [
            "/api/v1/projects",
            "/api/v1/projects/smart-table/statuses",
            "/api/v1/projects/smart-table/tasks",
            "/api/v1/projects/nanoclaw/tasks/DD-RETRY-403-GAP",
            "/api/v1/projects/amail/tasks/AM-42/dependencies",
        ] {
            assert!(board_path(ok).is_ok(), "{ok}");
        }
        for bad in [
            "/api/v1/projects/",
            "/api/v1/projects/x/tasks/T1/claim",
            "/api/v1/projects/x/tasks?assignee=a",
            "/api/v1/projects/../human/session",
            "/api/v1/projects/x/tasks/T1%2F..",
            "/api/v1/human/session",
            "/state.json",
            "/api/v1/projects/x/board",
            "/api/v1/projects/x/tasks/a b",
        ] {
            assert!(board_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn board_urls_reject_credentials_and_queries() {
        assert!(board_url("http://100.66.1.3:8091").is_ok());
        assert!(board_url("https://board.example.test/base/").is_ok());
        assert!(board_url("ftp://board").is_err());
        assert!(board_url("http://u:p@board").is_err());
        assert!(board_url("http://board/?x=1").is_err());
        assert_eq!(
            join(&board_url("https://board.example.test/base/").unwrap(), "/api/v1/projects"),
            "https://board.example.test/base/api/v1/projects"
        );
    }

    #[test]
    fn index_keeps_only_listed_fields() {
        let body = r#"{"tasks":[{"code":"T1","title":"标题","status_key":"doing","assignee":"a@b","updated_at":"2026-10-03T00:00:00Z","detail":"long"},{"title":"no code"}]}"#;
        let value: serde_json::Value = serde_json::from_str(&project_index(body).unwrap()).unwrap();
        let tasks = value["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0]["code"], "T1");
        assert!(tasks[0].get("detail").is_none());
        assert_eq!(tasks[0].as_object().unwrap().len(), INDEX_FIELDS.len());
        assert!(project_index("[]").is_err());
        // Idempotent: the SSH route may already have reduced the list remotely.
        assert_eq!(project_index(&project_index(body).unwrap()).unwrap(), project_index(body).unwrap());
    }

    #[test]
    fn routes_deserialize_from_frontend_shape() {
        let direct: Route = serde_json::from_str(r#"{"kind":"direct","url":"http://b"}"#).unwrap();
        assert!(matches!(direct, Route::Direct { .. }));
        let ssh: Route = serde_json::from_str(
            r#"{"kind":"ssh","sessionId":"s1","profile":{"tmuxId":"$1","tmuxCreated":1,"enabled":true}}"#,
        )
        .unwrap();
        assert!(matches!(ssh, Route::Ssh { .. }));
    }

    /// `TASKBOARD_LIVE_URL=http://host:8091 cargo test live_board -- --ignored`
    #[tokio::test]
    #[ignore]
    async fn live_board_direct_route() {
        let url = std::env::var("TASKBOARD_LIVE_URL").expect("TASKBOARD_LIVE_URL");
        let projects = direct(&url, "/api/v1/projects").await.unwrap();
        assert_eq!(projects.status, 200);
        let slug = serde_json::from_str::<serde_json::Value>(&projects.body).unwrap()["projects"][0]["slug"]
            .as_str()
            .unwrap()
            .to_string();
        let tasks = direct(&url, &format!("/api/v1/projects/{slug}/tasks")).await.unwrap();
        assert_eq!(tasks.status, 200);
        assert!(project_index(&tasks.body).unwrap().len() <= tasks.body.len());
        assert_eq!(direct(&url, &format!("/api/v1/projects/{slug}/tasks/NO-SUCH-CODE")).await.unwrap().status, 404);
        assert!(direct("http://127.0.0.1:9", "/api/v1/projects").await.unwrap_err().starts_with("看板不可达"));
    }

    #[test]
    fn open_rejects_non_web_urls() {
        assert!(taskboard_open("file:///etc/passwd".into()).is_err());
        assert!(taskboard_open("javascript:alert(1)".into()).is_err());
        assert!(taskboard_open("http://u:p@board".into()).is_err());
    }
}
