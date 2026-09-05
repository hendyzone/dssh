export interface MonitorStats {
  cpuPct: number | null;
  cpus: { name: string; pct: number | null }[];
  memory: {
    total: number;
    used: number;
    available: number;
    cached: number;
    swapTotal: number | null;
    swapUsed: number | null;
  } | null;
  loads: [number, number, number] | null;
  uptime: number | null;
  os: string | null;
  kernel: string | null;
  hostname: string | null;
  networks: {
    name: string;
    received: number;
    sent: number;
    receiveRate: number | null;
    sendRate: number | null;
  }[];
  disks: {
    device: string;
    fsType: string;
    mount: string;
    total: number;
    used: number;
    available: number;
    pct: number | null;
  }[];
  diskIo: { name: string; readRate: number | null; writeRate: number | null }[];
  processes: { pid: number; cpu: number; mem: number; command: string }[];
  processesAvailable: boolean;
}
export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(
    4,
    Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)),
  );
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
export function speed(value: number | null) {
  return value == null ? "—" : `${bytes(value)}/s`;
}
export function uptime(value: number | null) {
  if (value == null) return "—";
  return `${Math.floor(value / 86400)} 天 ${Math.floor(value / 3600) % 24} 时 ${Math.floor(value / 60) % 60} 分`;
}
export function networkRate(
  stats: MonitorStats,
  key: "sendRate" | "receiveRate",
) {
  return stats.networks.length && stats.networks.every((n) => n[key] != null)
    ? stats.networks.reduce((sum, n) => sum + n[key]!, 0)
    : null;
}
