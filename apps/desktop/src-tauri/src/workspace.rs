use crate::{
    ssh::SshState,
    tmux::{execute as remote_execute, quote},
};
use serde::Serialize;
use tauri::State;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    path: String,
    old_path: Option<String>,
    index: String,
    worktree: String,
}
#[derive(Serialize)]
pub struct Changes {
    root: String,
    branch: String,
    files: Vec<Change>,
}
fn git(root: &str) -> String {
    format!(
        "GIT_OPTIONAL_LOCKS=0 GIT_LITERAL_PATHSPECS=1 git --no-pager -c core.fsmonitor=false -C {}",
        quote(root)
    )
}
fn parse_status(raw: &str) -> Result<Vec<Change>, String> {
    let mut tokens = raw.split('\0').filter(|v| !v.is_empty());
    let mut files = Vec::new();
    while let Some(item) = tokens.next() {
        if item.len() < 4 || !item.is_char_boundary(3) {
            return Err("Git 状态格式无效".into());
        }
        let x = &item[0..1];
        let y = &item[1..2];
        let old_path = if x == "R" || x == "C" || y == "R" || y == "C" {
            Some(tokens.next().ok_or("重命名记录缺失")?.to_owned())
        } else {
            None
        };
        files.push(Change {
            path: item[3..].into(),
            old_path,
            index: x.into(),
            worktree: y.into(),
        });
    }
    Ok(files)
}
#[tauri::command]
pub async fn workspace_changes(
    ssh: State<'_, SshState>,
    session_id: String,
    path: String,
) -> Result<Changes, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("请输入远程项目的绝对路径".into());
    }
    let handle = ssh.get_handle(&session_id).await.ok_or("SSH 已断开")?;
    let root = execute(
        &handle,
        &format!("{} rev-parse --show-toplevel", git(&path)),
    )
    .await?
    .trim_end_matches('\n')
    .to_owned();
    let branch = execute(
        &handle,
        &format!(
            "{} symbolic-ref --short -q HEAD || {} rev-parse --short HEAD",
            git(&root),
            git(&root)
        ),
    )
    .await?
    .trim()
    .to_owned();
    let raw = execute(
        &handle,
        &format!(
            "{} status --porcelain=v1 -z --untracked-files=all",
            git(&root)
        ),
    )
    .await?;
    Ok(Changes {
        root,
        branch,
        files: parse_status(&raw)?,
    })
}
#[tauri::command]
pub async fn workspace_diff(
    ssh: State<'_, SshState>,
    session_id: String,
    root: String,
    path: String,
    kind: String,
) -> Result<String, String> {
    if !root.starts_with('/')
        || root.contains('\0')
        || path.starts_with('/')
        || path.contains('\0')
        || path.split('/').any(|part| part == "..")
    {
        return Err("无效的项目文件路径".into());
    }
    let handle = ssh.get_handle(&session_id).await.ok_or("SSH 已断开")?;
    let prefix = git(&root);
    let file = quote(&path);
    let command=match kind.as_str(){"staged"=>format!("{prefix} diff --cached --no-ext-diff --no-textconv --no-color -- {file}"),"working"=>format!("{prefix} diff --no-ext-diff --no-textconv --no-color -- {file}"),"untracked"=>format!("{prefix} diff --no-index --no-ext-diff --no-textconv --no-color -- /dev/null {file}; dssh_diff_code=$?; [ $dssh_diff_code -le 1 ]"),_=>return Err("无效差异类型".into())};
    execute(&handle, &command).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_unicode_rename_and_both_states() {
        let r = parse_status("MM a b.txt\0R  新名.txt\0旧名.txt\0?? new.txt\0").unwrap();
        assert_eq!(r.len(), 3);
        assert_eq!(r[0].worktree, "M");
        assert_eq!(r[1].old_path.as_deref(), Some("旧名.txt"));
        assert_eq!(r[2].index, "?");
    }
}

async fn execute(handle: &crate::ssh::SharedHandle, command: &str) -> Result<String, String> {
    remote_execute(handle, command)
        .await
        .map_err(|e| e.replace("tmux", "Git"))
}
