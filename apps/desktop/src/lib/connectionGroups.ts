import type { TabInfo } from "../types";

export interface ConnectionGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}
export const GROUP_COLORS = [
  { name: "蓝色", value: "#7aa2f7" },
  { name: "绿色", value: "#73bb87" },
  { name: "紫色", value: "#bb9af7" },
  { name: "橙色", value: "#e0af68" },
  { name: "粉色", value: "#e58cb4" },
  { name: "青色", value: "#56b6c2" },
];

/** Keep group members adjacent so visual order, shortcuts and close-right agree. */
export function moveConnection(
  tabs: TabInfo[],
  tabId: string,
  groupId?: string,
): TabInfo[] {
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab || tab.groupId === groupId) return tabs;
  const next = tabs.filter((t) => t.id !== tabId);
  const moved = { ...tab, groupId };
  const last = groupId
    ? next.reduce((index, t, i) => (t.groupId === groupId ? i : index), -1)
    : -1;
  next.splice(last < 0 ? next.length : last + 1, 0, moved);
  return next;
}
export function insertConnection(tabs: TabInfo[], tab: TabInfo): TabInfo[] {
  const last = tab.groupId
    ? tabs.reduce((index, t, i) => (t.groupId === tab.groupId ? i : index), -1)
    : -1;
  const next = [...tabs];
  next.splice(last < 0 ? next.length : last + 1, 0, tab);
  return next;
}
