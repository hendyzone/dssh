export const WORKER_GROUP = "Workers";
export const LEAD_GROUP = "Leads";

// Match worker tokens, not arbitrary project names containing "work".
const WORKER_TOKEN = /(?:^|[-_])(?:cw\d+[a-z]*|worker\d*[a-z]*)(?=$|[-_])/i;
// Machine segment of `worker-<project>-<machine>-<tool>`: cw1, cw1c, cw3b, dev, devc.
const MACHINE_SEGMENT = /^(?:cw\d+[a-z]*|dev[a-z]?)$/i;
const WORKER_SEGMENT = /^worker\d*[a-z]*$/i;

export interface TmuxSessionGroup {
  /** Top-level folder: manual group, "Leads", "Workers" or "" (ungrouped). */
  group: string;
  /** Project sub-folder inside Workers; "" when there is none. */
  subgroup: string;
  /** Compact card label (full name stays available as a tooltip). */
  display: string;
}

export const isLeadSession = (name: string) => /-lead$/i.test(name) || /^lead-/i.test(name);
export const isWorkerSession = (name: string) => WORKER_TOKEN.test(name);

/** Project of a worker session name, or "" when it cannot be told apart from the machine/tool. */
export function workerProject(name: string): string {
  let parts = name.split("-").filter(Boolean);
  if (parts.length && WORKER_SEGMENT.test(parts[0])) parts = parts.slice(1);
  const machine = parts.findIndex((part, index) => index > 0 && (MACHINE_SEGMENT.test(part) || WORKER_SEGMENT.test(part)));
  if (machine > 0) return parts.slice(0, machine).join("-");
  if (parts.some((part) => MACHINE_SEGMENT.test(part))) return "";
  // No machine segment (worker-smart-table-camera-claude): drop the tool and the role.
  if (parts.length >= 3) return parts.slice(0, -2).join("-");
  if (parts.length === 2) return parts[0];
  return "";
}

export function workerDisplayName(name: string, project: string): string {
  const prefix = `worker-${project}-`;
  return project && name.length > prefix.length && name.toLowerCase().startsWith(prefix.toLowerCase())
    ? name.slice(prefix.length)
    : name;
}

/** Project slug of a Lead session (`<project>-lead`, or legacy `lead-<project>`); matches the Workers sub-folder name. */
export function leadProject(name: string): string {
  return name.replace(/-lead$/i, "").replace(/^lead-/i, "");
}

/**
 * Manual group wins; then `*-lead` / `lead-*` → Leads (shown as the project slug);
 * then worker tokens → Workers, split into project sub-folders.
 */
export function classifyTmuxSession(name: string, manualGroup?: string): TmuxSessionGroup {
  const group = manualGroup || (isLeadSession(name) ? LEAD_GROUP : isWorkerSession(name) ? WORKER_GROUP : "");
  if (group === LEAD_GROUP && isLeadSession(name)) return { group, subgroup: "", display: leadProject(name) || name };
  if (group !== WORKER_GROUP) return { group, subgroup: "", display: name };
  const subgroup = workerProject(name);
  return { group, subgroup, display: workerDisplayName(name, subgroup) };
}

/** Manual folders alphabetically, then Leads, then Workers, ungrouped last. */
export function compareTmuxGroups(a: string, b: string): number {
  const rank = (group: string) => (!group ? 3 : group === WORKER_GROUP ? 2 : group === LEAD_GROUP ? 1 : 0);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Key used in the collapsed-folder set for a Workers project sub-folder. */
export const workerSubgroupKey = (project: string) => `${WORKER_GROUP}\u0000${project}`;
