//! Poll Linux resources through a short-lived SSH exec channel.
#[path = "monitor_data.rs"]
mod data;
use crate::ssh::SshState;
use std::{collections::HashMap, time::Duration};
use crate::runtime::{AppHandle, State};
use tokio::{sync::Mutex, task::JoinHandle};

// Fixed command only: no user-controlled strings are interpolated into the shell.
const SAMPLE_CMD: &str = r#"export LC_ALL=C
printf 'DSSH_MONITOR:cpu\n'; cat /proc/stat
printf 'DSSH_MONITOR:uptime\n'; cat /proc/uptime
printf 'DSSH_MONITOR:memory\n'; cat /proc/meminfo
printf 'DSSH_MONITOR:load\n'; cat /proc/loadavg
printf 'DSSH_MONITOR:os\n'; cat /etc/os-release
printf 'DSSH_MONITOR:kernel\n'; uname -r
printf 'DSSH_MONITOR:hostname\n'; hostname
printf 'DSSH_MONITOR:network\n'; cat /proc/net/dev
printf 'DSSH_MONITOR:disk\n'; df -PT -k
printf 'DSSH_MONITOR:io\n'; cat /proc/diskstats
printf 'DSSH_MONITOR:process\n'
ps -eo pid=,pcpu=,pmem=,args= --sort=-pcpu | head -n 100
ps -eo pid=,pcpu=,pmem=,args= --sort=-pmem | head -n 100
"#;
struct Task {
    owner: String,
    join: JoinHandle<()>,
}
#[derive(Default)]
pub struct MonitorState {
    tasks: Mutex<HashMap<String, Task>>,
}
#[derive(Debug, thiserror::Error, serde::Serialize)]
#[serde(untagged)]
pub enum MonitorError {
    #[error("{0}")]
    Other(String),
}
pub async fn monitor_start(
    app: AppHandle,
    ssh: State<'_, SshState>,
    state: State<'_, MonitorState>,
    session_id: String,
    owner_id: String,
) -> Result<(), MonitorError> {
    let mut tasks = state.tasks.lock().await;
    tasks.retain(|_, task| !task.join.is_finished());
    if tasks
        .get(&session_id)
        .is_some_and(|task| task.owner == owner_id)
    {
        return Ok(());
    }
    let handle = ssh
        .get_handle(&session_id)
        .await
        .ok_or_else(|| MonitorError::Other("会话不存在或已断开".into()))?;
    if let Some(old) = tasks.remove(&session_id) {
        old.join.abort();
    }
    let event = format!("monitor://{session_id}/{owner_id}");
    let join = tokio::spawn(async move {
        let mut previous = data::Previous::default();
        loop {
            match tokio::time::timeout(Duration::from_secs(12), sample(&handle, &mut previous))
                .await
            {
                Ok(Some(stats)) => {
                    let _ = app.emit(&format!("{event}/stats"), stats);
                }
                result => {
                    let message = if result.is_err() {
                        "采集超时，请检查连接后重试"
                    } else {
                        "采集失败，请检查 SSH 连接及 Linux /proc 读取权限"
                    };
                    let _ = app.emit(&format!("{event}/error"), message);
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
    tasks.insert(
        session_id,
        Task {
            owner: owner_id,
            join,
        },
    );
    Ok(())
}
pub async fn monitor_stop(
    state: State<'_, MonitorState>,
    session_id: String,
    owner_id: String,
) -> Result<(), MonitorError> {
    let mut tasks = state.tasks.lock().await;
    // A delayed cleanup from an old React effect must never stop a newer monitor.
    if tasks
        .get(&session_id)
        .is_some_and(|task| task.owner == owner_id)
    {
        if let Some(task) = tasks.remove(&session_id) {
            task.join.abort();
        }
    }
    Ok(())
}
async fn sample(
    handle: &crate::ssh::SharedHandle,
    previous: &mut data::Previous,
) -> Option<data::Stats> {
    let mut channel = handle.channel_open_session().await.ok()?;
    channel.exec(false, SAMPLE_CMD).await.ok()?;
    let mut raw = Vec::new();
    while let Some(message) = channel.wait().await {
        match message {
            russh::ChannelMsg::Data { data } => {
                if raw.len() + data.len() > 2 * 1024 * 1024 {
                    let _ = channel.close().await;
                    return None;
                }
                raw.extend_from_slice(&data);
            }
            russh::ChannelMsg::Eof | russh::ChannelMsg::Close => break,
            // stderr must not be parsed as telemetry.
            _ => {}
        }
    }
    let _ = channel.close().await;
    data::parse_sample(&String::from_utf8_lossy(&raw), previous)
}
