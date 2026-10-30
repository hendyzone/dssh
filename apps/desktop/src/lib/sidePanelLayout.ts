/** One registry for both icon rails: what the panels are, where they start, and how users arrange them. */

export type PanelSide = "left" | "right";
export type PanelId =
  | "connections" | "sftp" | "tmux" | "team" | "adventure" | "forward"
  | "tasks" | "changes" | "monitor" | "quota" | "collaboration";

export interface PanelDefinition {
  id: PanelId;
  label: string;
  defaultSide: PanelSide;
  /** Gaps leave room to insert without renumbering everything. */
  defaultOrder: number;
}

export const PANEL_DEFINITIONS: PanelDefinition[] = [
  {id: "connections", label: "服务器与连接", defaultSide: "left", defaultOrder: 100},
  {id: "sftp", label: "文件 · SFTP", defaultSide: "right", defaultOrder: 200},
  {id: "tmux", label: "tmux 会话", defaultSide: "right", defaultOrder: 210},
  {id: "team", label: "团队 · 打开成员终端", defaultSide: "right", defaultOrder: 220},
  {id: "adventure", label: "冒险团", defaultSide: "right", defaultOrder: 230},
  {id: "forward", label: "端口转发", defaultSide: "right", defaultOrder: 240},
  {id: "tasks", label: "任务状态与提醒", defaultSide: "right", defaultOrder: 250},
  {id: "changes", label: "代码修改", defaultSide: "right", defaultOrder: 260},
  {id: "monitor", label: "服务器监控", defaultSide: "right", defaultOrder: 270},
  {id: "quota", label: "模型额度", defaultSide: "right", defaultOrder: 280},
  {id: "collaboration", label: "Agent 协作", defaultSide: "right", defaultOrder: 290},
];

export interface PanelPreference { side: PanelSide; hidden: boolean; order: number }
export type PanelLayout = Record<string, PanelPreference>;

const DEFINITION = new Map(PANEL_DEFINITIONS.map(item => [item.id, item]));
export const panelDefinition = (id: string) => DEFINITION.get(id as PanelId);
export const panelIds = () => PANEL_DEFINITIONS.map(item => item.id);

export function defaultLayout(): PanelLayout {
  return Object.fromEntries(PANEL_DEFINITIONS.map(item => [item.id, {
    side: item.defaultSide, hidden: false, order: item.defaultOrder,
  }]));
}

/** Unknown ids are ignored; missing ids (new releases) take their default side, after existing panels. */
export function normalizeLayout(raw: unknown, legacySides: Record<string, string> = {}): PanelLayout {
  const layout = defaultLayout();
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  for (const item of PANEL_DEFINITIONS) {
    const value = source[item.id];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entry = value as Record<string, unknown>;
      if (entry.side === "left" || entry.side === "right") layout[item.id].side = entry.side;
      if (typeof entry.hidden === "boolean") layout[item.id].hidden = entry.hidden;
      if (Number.isFinite(entry.order)) layout[item.id].order = Number(entry.order);
    } else if (legacySides[item.id] === "left" || legacySides[item.id] === "right") {
      layout[item.id].side = legacySides[item.id] as PanelSide;
    }
  }
  // A new panel appended after the current end of its default side.
  for (const item of PANEL_DEFINITIONS) {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && (raw as Record<string, unknown>)[item.id]) continue;
    if (legacySides[item.id]) continue;
    const last = Math.max(0, ...panelsOnSide(layout, item.defaultSide).map(panel => layout[panel.id].order));
    layout[item.id].order = last + 10;
  }
  return ensureVisible(layout);
}

export function panelsOnSide(layout: PanelLayout, side: PanelSide): PanelDefinition[] {
  return PANEL_DEFINITIONS
    .filter(item => layout[item.id].side === side)
    .sort((a, b) => layout[a.id].order - layout[b.id].order || a.defaultOrder - b.defaultOrder);
}

export function railPanels(layout: PanelLayout, side: PanelSide): PanelDefinition[] {
  return panelsOnSide(layout, side).filter(item => !layout[item.id].hidden);
}

export function visiblePanels(layout: PanelLayout): PanelDefinition[] {
  return PANEL_DEFINITIONS.filter(item => !layout[item.id].hidden);
}

/** Never leave the rails empty: the last visible panel stays visible. */
export function ensureVisible(layout: PanelLayout): PanelLayout {
  if (visiblePanels(layout).length > 0) return layout;
  const fallback = PANEL_DEFINITIONS.find(item => item.id === "connections") ?? PANEL_DEFINITIONS[0];
  const next = cloneLayout(layout);
  next[fallback.id].hidden = false;
  return next;
}

export function cloneLayout(layout: PanelLayout): PanelLayout {
  return Object.fromEntries(Object.entries(layout).map(([id, value]) => [id, {...value}]));
}

export const canHidePanel = (layout: PanelLayout, id: string): boolean =>
  !visiblePanels(layout).every(item => item.id === id);

export function setPanelHidden(layout: PanelLayout, id: string, hidden: boolean): PanelLayout {
  if (!DEFINITION.has(id as PanelId)) return layout;
  if (hidden && !canHidePanel(layout, id)) return layout;
  const next = cloneLayout(layout);
  next[id].hidden = hidden;
  return ensureVisible(next);
}

export function setPanelSide(layout: PanelLayout, id: string, side: PanelSide): PanelLayout {
  if (!DEFINITION.has(id as PanelId)) return layout;
  if (layout[id].side === side) return layout;
  const next = cloneLayout(layout);
  next[id].side = side;
  normalizeOrders(next);
  return next;
}

/** Move to a rail at an index (drag across) or reorder within (drag inside). */
export function placePanel(layout: PanelLayout, id: string, side: PanelSide, index: number): PanelLayout {
  if (!DEFINITION.has(id as PanelId)) return layout;
  const next = cloneLayout(layout);
  next[id].side = side;
  const ids: string[] = panelsOnSide(next, side).filter(item => item.id !== id).map(item => item.id);
  const at = Math.max(0, Math.min(ids.length, Math.round(index)));
  ids.splice(at, 0, id);
  ids.forEach((panelId, position) => { next[panelId].order = (position + 1) * 10; });
  normalizeOrders(next);
  return next;
}

function normalizeOrders(layout: PanelLayout) {
  for (const side of ["left", "right"] as const) {
    panelsOnSide(layout, side).forEach((item, index) => { layout[item.id].order = (index + 1) * 10; });
  }
}

/** Read the layout from settings; legacy per-panel side keys are the migration source. */
export function settingsLayout(settings: {panelLayout?: unknown} | undefined): PanelLayout {
  const legacy: Record<string, string> = {};
  for (const item of PANEL_DEFINITIONS) {
    if (item.id === "connections") continue;
    try {
      const value = localStorage.getItem(`dssh.panel-side.${item.id}`);
      if (value === "left" || value === "right") legacy[item.id] = value;
    } catch { /* storage is optional */ }
  }
  return normalizeLayout(settings?.panelLayout, legacy);
}
