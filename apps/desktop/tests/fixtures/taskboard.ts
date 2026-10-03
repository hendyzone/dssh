/** Fake taskboard for tests: answers `taskboard_get` like the real REST API (0.9.0). */
export const NOW = Date.parse("2026-10-03T12:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60000).toISOString();

export const statuses = [
  { key: "backlog", name: "待处理", color: "#8a8f99" },
  { key: "doing", name: "进行中", color: "#3d8bfd" },
  { key: "review", name: "待人工验收", color: "#f0a868" },
  { key: "blocked", name: "已阻塞", color: "#ff7a7a" },
  { key: "done", name: "已完成", color: "#6fcf7f" },
];
const task = (code: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${code}`, code, title: `${code} 标题`, assignee: "", summary: "", detail: "", status_key: "doing",
  acceptance: "", blocked_reason: "", created_at: ago(5000), updated_at: ago(30), status_changed_at: ago(180), ...extra,
});
export const board: Record<string, { name: string; tasks: Record<string, unknown>[]; deps?: Record<string, unknown[]> }> = {
  "smart-table": {
    name: "智能台球桌",
    tasks: [
      task("T1090", {
        title: "击球辅助线样式统一：实线改虚线并补齐全部入口", assignee: "smart-table-cw3d-pi@motern-agent.com",
        summary: "等：设备验收", status_key: "review", acceptance: "9191 实机核对通过", detail: "## 详细记录\n第一步……",
      }),
      task("T1091", { title: "被阻塞的任务", status_key: "blocked", blocked_reason: "等硬件到货", assignee: "Claude Code" }),
      task("T1092", { title: "依赖示例", status_key: "backlog" }),
      task("T90", { title: "短编号" }),
      task("ST-1090", { title: "同尾号的另一个任务", status_key: "done" }),
    ],
    deps: { T1090: [{ code: "T1091", title: "被阻塞的任务", status_key: "blocked", completed: false }, { code: "T1092", title: "依赖示例", status_key: "done", completed: true }] },
  },
  amail: { name: "amail", tasks: [task("AM-42", { title: "邮件投递适配" }), task("AM-7", { title: "四工具投递" }), task("T1090", { title: "amail 里同号的任务" })] },
  nanoclaw: { name: "AgentDock (nanoclaw)", tasks: [task("DD-RETRY-403-GAP", { title: "钉钉 403 重试缺口" })] },
};

export function respond(path: string, index = false): { status: number; body: string } {
  const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value) });
  if (path === "/api/v1/projects") return json(200, { projects: Object.entries(board).map(([slug, p]) => ({ slug, name: p.name, archived: false })) });
  const m = path.match(/^\/api\/v1\/projects\/([^/]+)(?:\/(statuses|tasks))?(?:\/([^/]+))?(?:\/(dependencies))?$/);
  if (!m) return json(404, { error: "not found" });
  const [, slug, kind, code, deps] = m;
  const project = board[slug];
  if (kind === "statuses") return json(200, { statuses: project ? statuses : [] });
  if (kind === "tasks" && !code) {
    const tasks = project?.tasks ?? [];
    return json(200, { tasks: index ? tasks.map(t => ({ code: t.code, title: t.title, status_key: t.status_key, assignee: t.assignee, updated_at: t.updated_at })) : tasks });
  }
  const found = project?.tasks.find(t => t.code === code);
  if (!found) return json(404, { error: "记录不存在" });
  if (deps) return json(200, { dependencies: project?.deps?.[code] ?? [] });
  return json(200, found);
}

/** `invoke` implementation; set `offline` to simulate an unreachable board. */
export function fakeInvoke(state: { offline?: boolean; calls?: string[]; opened?: string[] } = {}) {
  return async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "taskboard_open") { state.opened?.push(String(args.url)); return; }
    if (command !== "taskboard_get") return undefined;
    state.calls?.push(String(args.path));
    if (state.offline) throw "看板不可达：无法连接看板服务";
    return respond(String(args.path), Boolean(args.index));
  };
}
