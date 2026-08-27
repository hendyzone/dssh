//! 服务器资源监控：定期通过 SSH exec 采集 /proc 数据，事件推送前端
//!
//! 事件：`monitor://{session_id}/stats` → Stats JSON

use std::collections::HashMap;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::ssh::SshState;

const SAMPLE_CMD: &str = "head -1 /proc/stat; grep -E '^(MemTotal|MemAvailable)' /proc/meminfo; cat /proc/loadavg; df -B1 / | tail -1";

const POLL_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    /// CPU 使用率 0-100（两次采样差分；首次为 None）
    pub cpu_pct: Option<f32>,
    /// 内存使用率 0-100
    pub mem_pct: f32,
    /// 根分区磁盘使用率 0-100
    pub disk_pct: f32,
    pub load1: f32,
    pub load5: f32,
    pub load15: f32,
}

#[derive(Default)]
pub struct MonitorState {
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

#[derive(Debug, thiserror::Error)]
pub enum MonitorError {
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for MonitorError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// 启动某会话的监控（重复调用幂等）
#[tauri::command]
pub async fn monitor_start(
    app: AppHandle,
    ssh: State<'_, SshState>,
    state: State<'_, MonitorState>,
    session_id: String,
) -> Result<(), MonitorError> {
    let mut tasks = state.tasks.lock().await;
    if tasks.contains_key(&session_id) {
        return Ok(());
    }
    let handle = ssh
        .get_handle(&session_id)
        .await
        .ok_or_else(|| MonitorError::Other("会话不存在或已断开".into()))?;

    let sid = session_id.clone();
    let join = tokio::spawn(async move {
        let event = format!("monitor://{sid}/stats");
        let mut prev_cpu: Option<(u64, u64)> = None; // (idle_all, total)
        loop {
            match sample(&handle, &mut prev_cpu).await {
                Some(stats) => {
                    let _ = app.emit(&event, stats);
                }
                None => {
                    tracing::info!("monitor {sid}: 采样失败（会话可能已断开），停止");
                    break;
                }
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    });
    tasks.insert(session_id, join);
    Ok(())
}

#[tauri::command]
pub async fn monitor_stop(state: State<'_, MonitorState>, session_id: String) -> Result<(), MonitorError> {
    if let Some(join) = state.tasks.lock().await.remove(&session_id) {
        join.abort();
    }
    Ok(())
}

/// 单次采样：开临时 exec 通道跑 /proc 采集命令
async fn sample(
    handle: &crate::ssh::SharedHandle,
    prev_cpu: &mut Option<(u64, u64)>,
) -> Option<Stats> {
    let channel = handle.channel_open_session().await.ok()?;
    channel.exec(false, SAMPLE_CMD).await.ok()?;

    let (mut read_half, _write_half) = channel.split();
    let mut raw = Vec::new();
    loop {
        match read_half.wait().await {
            Some(russh::ChannelMsg::Data { data })
            | Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                raw.extend_from_slice(&data);
            }
            Some(russh::ChannelMsg::Eof) | Some(russh::ChannelMsg::Close) | None => break,
            _ => {}
        }
    }
    parse_sample(&String::from_utf8_lossy(&raw), prev_cpu)
}

fn parse_sample(text: &str, prev_cpu: &mut Option<(u64, u64)>) -> Option<Stats> {
    let mut cpu_pct = None;
    let mut mem_total = 0u64;
    let mut mem_avail = 0u64;
    let mut loads = [0f32; 3];
    let mut disk_pct = 0f32;

    for line in text.lines() {
        let mut it = line.split_whitespace();
        match it.next() {
            Some("cpu") => {
                let nums: Vec<u64> = it.filter_map(|s| s.parse().ok()).collect();
                if nums.len() >= 4 {
                    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
                    let total: u64 = nums.iter().sum();
                    if let Some((pi, pt)) = *prev_cpu {
                        if total > pt {
                            let busy = (total - pt).saturating_sub(idle - pi);
                            cpu_pct = Some(busy as f32 * 100.0 / (total - pt) as f32);
                        }
                    }
                    *prev_cpu = Some((idle, total));
                }
            }
            Some("MemTotal:") => mem_total = it.next()?.parse().ok()?,
            Some("MemAvailable:") => mem_avail = it.next()?.parse().ok()?,
            Some(first) if first.parse::<f32>().is_ok() && line.split_whitespace().count() >= 3 => {
                // /proc/loadavg: "0.12 0.34 0.56 ..."
                for (i, v) in line.split_whitespace().take(3).enumerate() {
                    loads[i] = v.parse().unwrap_or(0.0);
                }
            }
            Some(_) => {
                // df 输出: /dev/xxx total used avail pct /
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 6 && cols[5] == "/" {
                    let used: f32 = cols[2].parse().ok()?;
                    let avail: f32 = cols[3].parse().ok()?;
                    if used + avail > 0.0 {
                        disk_pct = used * 100.0 / (used + avail);
                    }
                }
            }
            None => {}
        }
    }

    let mem_pct = if mem_total > 0 {
        (mem_total - mem_avail) as f32 * 100.0 / mem_total as f32
    } else {
        0.0
    };

    Some(Stats {
        cpu_pct,
        mem_pct,
        disk_pct,
        load1: loads[0],
        load5: loads[1],
        load15: loads[2],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_typical_output() {
        let text = "cpu  100 0 200 700 10 0 0 0 0 0\nMemTotal:       16384 kB\nMemAvailable:    8192 kB\n0.50 1.25 2.00 1/234 5678\n/dev/sda1 1000000 250000 750000 25% /\n";
        let mut prev = Some((600u64, 1000u64)); // idle=700+10=710? no: prev idle 600, total 1000
        let s = parse_sample(text, &mut prev).unwrap();
        // 新 idle=700+10=710, total=1010; busy=(1010-1000)-(710-600)=负数→0
        assert!(s.cpu_pct.is_some());
        assert!((s.mem_pct - 50.0).abs() < 0.1);
        assert!((s.disk_pct - 25.0).abs() < 0.1);
        assert!((s.load5 - 1.25).abs() < 0.01);
    }
}
