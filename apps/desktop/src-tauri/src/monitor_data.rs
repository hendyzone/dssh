//! Linux resource snapshots, parsed separately from SSH transport.
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    pub name: String,
    pub pct: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub cached: u64,
    pub swap_total: Option<u64>,
    pub swap_used: Option<u64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub name: String,
    pub received: u64,
    pub sent: u64,
    pub receive_rate: Option<f64>,
    pub send_rate: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub device: String,
    pub fs_type: String,
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
    pub pct: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskIo {
    pub name: String,
    pub read_rate: Option<f64>,
    pub write_rate: Option<f64>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pub pid: u32,
    pub cpu: f64,
    pub mem: f64,
    pub command: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub cpu_pct: Option<f64>,
    pub cpus: Vec<Cpu>,
    pub memory: Option<Memory>,
    pub loads: Option<[f64; 3]>,
    pub uptime: Option<f64>,
    pub os: Option<String>,
    pub kernel: Option<String>,
    pub hostname: Option<String>,
    pub networks: Vec<Network>,
    pub disks: Vec<Disk>,
    pub disk_io: Vec<DiskIo>,
    pub processes: Vec<Process>,
    pub processes_available: bool,
}
#[derive(Default)]
pub struct Previous {
    cpu: HashMap<String, (u64, u64)>,
    network: HashMap<String, (u64, u64)>,
    io: HashMap<String, (u64, u64)>,
    uptime: Option<f64>,
}
fn number(s: Option<&&str>) -> Option<u64> {
    s?.parse().ok()
}
fn finite(s: &str) -> Option<f64> {
    s.parse::<f64>().ok().filter(|n| n.is_finite() && *n >= 0.0)
}
fn rate(current: u64, previous: Option<u64>, elapsed: Option<f64>) -> Option<f64> {
    Some(current.checked_sub(previous?)? as f64 / elapsed.filter(|v| *v > 0.0)?)
}

pub fn parse_sample(text: &str, previous: &mut Previous) -> Option<Stats> {
    let mut sections: HashMap<&str, Vec<&str>> = HashMap::new();
    let mut section = "";
    for line in text.lines() {
        if let Some(name) = line.strip_prefix("DSSH_MONITOR:") {
            section = name.trim();
        } else if !line.trim().is_empty() {
            sections.entry(section).or_default().push(line);
        }
    }
    let lines = |name| sections.get(name).cloned().unwrap_or_default();
    let first = |name| {
        sections
            .get(name)
            .and_then(|v| v.first())
            .map(|s| s.to_string())
    };
    let uptime = first("uptime").and_then(|s| finite(s.split_whitespace().next()?));
    let elapsed = uptime
        .zip(previous.uptime)
        .map(|(a, b)| a - b)
        .filter(|v| *v > 0.0);
    let reset = uptime.zip(previous.uptime).is_some_and(|(a, b)| a < b);
    if reset {
        *previous = Previous::default();
    }
    let mut next = Previous {
        uptime,
        ..Default::default()
    };
    let mut cpus = Vec::new();
    let mut cpu_pct = None;
    for line in lines("cpu") {
        let cols: Vec<_> = line.split_whitespace().collect();
        let Some(name) = cols.first().filter(|n| n.starts_with("cpu")) else {
            continue;
        };
        // guest and guest_nice are already included in user/nice; do not count them twice.
        let values: Vec<u64> = cols
            .iter()
            .skip(1)
            .take(8)
            .filter_map(|s| s.parse().ok())
            .collect();
        if values.len() < 4 {
            continue;
        }
        let total: u64 = values.iter().sum();
        let idle = values[3] + values.get(4).copied().unwrap_or(0);
        let pct = previous.cpu.get(*name).and_then(|&(pi, pt)| {
            let dt = total.checked_sub(pt).filter(|v| *v > 0)?;
            let di = idle.checked_sub(pi)?;
            Some(dt.saturating_sub(di) as f64 * 100.0 / dt as f64)
        });
        next.cpu.insert(name.to_string(), (idle, total));
        if *name == "cpu" {
            cpu_pct = pct;
        } else {
            cpus.push(Cpu {
                name: name.to_string(),
                pct,
            });
        }
    }
    // Missing /proc/stat indicates an unsupported host or failed command, not an idle server.
    if !next.cpu.contains_key("cpu") {
        return None;
    }
    let mem: HashMap<_, _> = lines("memory")
        .iter()
        .filter_map(|line| {
            let (key, value) = line.split_once(':')?;
            Some((
                key.to_string(),
                value
                    .split_whitespace()
                    .next()?
                    .parse::<u64>()
                    .ok()?
                    .checked_mul(1024)?,
            ))
        })
        .collect();
    let memory = mem
        .get("MemTotal")
        .filter(|&&v| v > 0)
        .zip(mem.get("MemAvailable"))
        .map(|(&total, &available)| {
            let available = available.min(total);
            let cached = mem
                .get("Cached")
                .copied()
                .unwrap_or(0)
                .saturating_add(mem.get("SReclaimable").copied().unwrap_or(0))
                .saturating_sub(mem.get("Shmem").copied().unwrap_or(0))
                .min(total);
            let swap_total = mem.get("SwapTotal").copied();
            let swap_used = swap_total
                .zip(mem.get("SwapFree"))
                .map(|(t, &f)| t.saturating_sub(f));
            Memory {
                total,
                used: total - available,
                available,
                cached,
                swap_total,
                swap_used,
            }
        });
    let loads = first("load").and_then(|s| {
        let v: Vec<_> = s.split_whitespace().take(3).filter_map(finite).collect();
        (v.len() == 3).then(|| [v[0], v[1], v[2]])
    });
    let mut networks = Vec::new();
    for line in lines("network") {
        let Some((name, data)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name == "lo" {
            continue;
        }
        let c: Vec<_> = data.split_whitespace().collect();
        let Some((received, sent)) = number(c.first()).zip(number(c.get(8))) else {
            continue;
        };
        let prev = previous.network.get(name);
        networks.push(Network {
            name: name.into(),
            received,
            sent,
            receive_rate: rate(received, prev.map(|v| v.0), elapsed),
            send_rate: rate(sent, prev.map(|v| v.1), elapsed),
        });
        next.network.insert(name.into(), (received, sent));
    }
    let mut disks = Vec::new();
    for line in lines("disk") {
        let c: Vec<_> = line.split_whitespace().collect();
        if c.len() < 7 {
            continue;
        }
        let Some((total, used, available)) = number(c.get(2))
            .zip(number(c.get(3)))
            .zip(number(c.get(4)))
            .map(|((t, u), a)| {
                (
                    t.saturating_mul(1024),
                    u.saturating_mul(1024),
                    a.saturating_mul(1024),
                )
            })
        else {
            continue;
        };
        if matches!(c[1], "tmpfs" | "devtmpfs" | "squashfs") {
            continue;
        }
        let pct = finite(c[5].trim_end_matches('%')).map(|p| p.min(100.0));
        disks.push(Disk {
            device: c[0].into(),
            fs_type: c[1].into(),
            mount: c[6..].join(" "),
            total,
            used,
            available,
            pct,
        });
    }
    let mut disk_io = Vec::new();
    for line in lines("io") {
        let c: Vec<_> = line.split_whitespace().collect();
        if c.len() < 10 {
            continue;
        }
        let name = c[2];
        if name.starts_with("loop") || name.starts_with("ram") {
            continue;
        }
        let Some((read, write)) = number(c.get(5)).zip(number(c.get(9))) else {
            continue;
        };
        let (read, write) = (read.saturating_mul(512), write.saturating_mul(512));
        let prev = previous.io.get(name);
        disk_io.push(DiskIo {
            name: name.into(),
            read_rate: rate(read, prev.map(|p| p.0), elapsed),
            write_rate: rate(write, prev.map(|p| p.1), elapsed),
        });
        next.io.insert(name.into(), (read, write));
    }
    let mut processes = Vec::new();
    for line in lines("process") {
        let c: Vec<_> = line.split_whitespace().collect();
        if c.len() < 4 {
            continue;
        }
        let Some((pid, cpu, mem)) = c[0]
            .parse::<u32>()
            .ok()
            .zip(finite(c[1]))
            .zip(finite(c[2]))
            .map(|((p, c), m)| (p, c, m))
        else {
            continue;
        };
        if processes.iter().any(|p: &Process| p.pid == pid) {
            continue;
        }
        processes.push(Process {
            pid,
            cpu,
            mem,
            command: c[3..].join(" "),
        });
    }
    let processes_available = !processes.is_empty();
    let os = lines("os").iter().find_map(|line| {
        line.strip_prefix("PRETTY_NAME=")
            .map(|s| s.trim_matches('"').to_string())
    });
    *previous = next;
    Some(Stats {
        cpu_pct,
        cpus,
        memory,
        loads,
        uptime,
        os,
        kernel: first("kernel"),
        hostname: first("hostname"),
        networks,
        disks,
        disk_io,
        processes,
        processes_available,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(cpu: &str, uptime: u32, net: u64) -> String {
        format!("DSSH_MONITOR:cpu\n{cpu}\nDSSH_MONITOR:uptime\n{uptime} 0\nDSSH_MONITOR:memory\nMemTotal: 1000 kB\nMemAvailable: 400 kB\nCached: 200 kB\nSwapTotal: 100 kB\nSwapFree: 60 kB\nDSSH_MONITOR:network\n eth0: {net} 0 0 0 0 0 0 0 {net} 0\nDSSH_MONITOR:disk\n/dev/sda1 ext4 1000 400 500 45% /\nDSSH_MONITOR:io\n8 0 sda 0 0 {net} 0 0 0 {net} 0\nDSSH_MONITOR:process\n12 5.0 2.0 node server.js\nDSSH_MONITOR:load\n0.5 1 2 1/10 12\n")
    }
    #[test]
    fn first_sample_has_no_rates_and_parses_capacity() {
        let s = parse_sample(
            &snapshot(
                "cpu 100 0 100 800 0 0 0 0 50 0\ncpu0 100 0 100 800",
                10,
                100,
            ),
            &mut Previous::default(),
        )
        .unwrap();
        assert_eq!(s.cpu_pct, None);
        assert_eq!(s.networks[0].receive_rate, None);
        assert_eq!(s.memory.unwrap().used, 600 * 1024);
        assert_eq!(s.disks[0].pct, Some(45.0));
        assert_eq!(s.processes[0].command, "node server.js");
    }
    #[test]
    fn deltas_exclude_guest_and_use_remote_elapsed_time() {
        let mut p = Previous::default();
        parse_sample(
            &snapshot(
                "cpu 100 0 100 800 0 0 0 0 50 0\ncpu0 100 0 100 800",
                10,
                100,
            ),
            &mut p,
        )
        .unwrap();
        let s = parse_sample(
            &snapshot(
                "cpu 150 0 100 850 0 0 0 0 100 0\ncpu0 150 0 100 850",
                12,
                300,
            ),
            &mut p,
        )
        .unwrap();
        assert_eq!(s.cpu_pct, Some(50.0));
        assert_eq!(s.cpus[0].pct, Some(50.0));
        assert_eq!(s.networks[0].receive_rate, Some(100.0));
        assert_eq!(s.disk_io[0].read_rate, Some(51200.0));
    }
    #[test]
    fn reboot_and_counter_reset_do_not_underflow() {
        let mut p = Previous::default();
        parse_sample(&snapshot("cpu 100 0 100 800", 100, 1000), &mut p);
        let s = parse_sample(&snapshot("cpu 10 0 10 80", 1, 10), &mut p).unwrap();
        assert_eq!(s.cpu_pct, None);
        assert_eq!(s.networks[0].receive_rate, None);
        let s = parse_sample(&snapshot("cpu 20 0 20 100", 2, 1), &mut p).unwrap();
        assert_eq!(s.networks[0].receive_rate, None);
    }
    #[test]
    fn missing_data_is_not_zero_and_invalid_output_fails() {
        assert!(parse_sample("Permission denied", &mut Previous::default()).is_none());
        let s = parse_sample("DSSH_MONITOR:cpu\ncpu 1 0 1 8", &mut Previous::default()).unwrap();
        assert!(s.memory.is_none());
        assert!(s.loads.is_none());
        assert!(!s.processes_available);
    }
}
