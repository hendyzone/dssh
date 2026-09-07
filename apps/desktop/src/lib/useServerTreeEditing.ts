import { useEffect, useRef, useState } from "react";
import { invoke } from "../platform/core";
import type { ServerEntry } from "../types";
import { groupParts } from "./serverGroups";

interface Layout {
  folders: string[];
  order: Record<string, string[]>;
}
interface Drop {
  group: string;
  anchor?: string;
  after?: boolean;
}
const KEY = "dssh.sidebar.tree-layout";
export function useServerTreeEditing(
  servers: ServerEntry[],
  onChanged?: (servers: ServerEntry[]) => void,
) {
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
      return {
        folders: Array.isArray(raw.folders)
          ? raw.folders.filter((s: unknown) => typeof s === "string")
          : [],
        order: Object.fromEntries(
          Object.entries(raw.order ?? {}).filter(
            ([, v]) =>
              Array.isArray(v) && v.every((id) => typeof id === "string"),
          ),
        ) as Record<string, string[]>,
      };
    } catch {
      return { folders: [], order: {} };
    }
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [dragName, setDragName] = useState("");
  const drag = useRef<{
    id: string;
    x: number;
    y: number;
    started: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const locked = useRef(false);
  const saveLayout = (next: Layout) => {
    localStorage.setItem(KEY, JSON.stringify(next));
    setLayout(next);
  };
  const addFolder = (parent: string, name: string) => {
    name = name.trim();
    if (!name || name === "." || name === ".." || /[\\/\x00-\x1f]/.test(name))
      throw new Error("请输入文件夹名称，不能包含斜杠或控制字符");
    const path = parent ? `${parent}/${name}` : name;
    const existing = [
      ...layout.folders,
      ...servers.map((s) => groupParts(s.group).join("/")),
    ];
    if (existing.some((p) => p === path || p.startsWith(path + "/")))
      throw new Error("同级已有这个文件夹");
    saveLayout({ ...layout, folders: [...layout.folders, path] });
    return path;
  };
  const move = async (id: string, destination: Drop) => {
    if (locked.current || !onChanged) return;
    const server = servers.find((s) => s.id === id);
    if (!server || destination.anchor === id) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const oldGroup = groupParts(server.group).join("/");
      const group = destination.group;
      const inGroup = servers
        .filter((s) => groupParts(s.group).join("/") === group && s.id !== id)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((s) => s.id);
      const sorted = [
        ...(layout.order[group] ?? []).filter((other) =>
          inGroup.includes(other),
        ),
        ...inGroup.filter(
          (other) => !(layout.order[group] ?? []).includes(other),
        ),
      ];
      const index = destination.anchor
        ? sorted.indexOf(destination.anchor)
        : -1;
      sorted.splice(
        index < 0 ? sorted.length : index + (destination.after ? 1 : 0),
        0,
        id,
      );
      if (oldGroup !== group) {
        const updated = await invoke<ServerEntry[]>("servers_move", {
          id,
          group: group || null,
        });
        onChanged(updated);
      }
      saveLayout({
        folders: [
          ...new Set([...layout.folders, oldGroup, group].filter(Boolean)),
        ],
        order: {
          ...layout.order,
          [oldGroup]: (layout.order[oldGroup] ?? []).filter(
            (other) => other !== id,
          ),
          [group]: sorted,
        },
      });
    } catch {
      setError("未能完成移动或保存顺序，请检查本机存储后重试。");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    const locate = (x: number, y: number): Drop | null => {
      const element = document.elementFromPoint(x, y);
      const row = element?.closest<HTMLElement>("[data-tree-server]");
      if (row)
        return {
          group: row.dataset.treeGroup ?? "",
          anchor: row.dataset.treeServer,
          after:
            y >
            row.getBoundingClientRect().top +
              row.getBoundingClientRect().height / 2,
        };
      const folder = element?.closest<HTMLElement>("[data-tree-folder]");
      return folder ? { group: folder.dataset.treeFolder ?? "" } : null;
    };
    const cancel = () => {
      drag.current = null;
      setDrop(null);
      setDragName("");
    };
    const motion = (event: PointerEvent) => {
      const start = drag.current;
      if (
        !start ||
        (!start.started &&
          Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6)
      )
        return;
      start.started = true;
      suppressClick.current = true;
      event.preventDefault();
      setDragName(servers.find((s) => s.id === start.id)?.name ?? "连接");
      setDrop(locate(event.clientX, event.clientY));
      const list = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest(".server-groups");
      if (list) {
        const rect = list.getBoundingClientRect();
        if (event.clientY < rect.top + 30) list.scrollTop -= 14;
        if (event.clientY > rect.bottom - 30) list.scrollTop += 14;
      }
    };
    const finish = (event: PointerEvent) => {
      const start = drag.current;
      const target = start?.started
        ? locate(event.clientX, event.clientY)
        : null;
      cancel();
      if (start && target) void move(start.id, target);
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("pointermove", motion, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointermove", motion);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, [servers, layout, onChanged]);
  return {
    layout,
    addFolder,
    error,
    busy,
    drop,
    dragName,
    suppressClick,
    startDrag: (id: string, event: React.PointerEvent) => {
      if (
        !onChanged ||
        locked.current ||
        event.button !== 0 ||
        (event.target as Element).closest("button,input")
      )
        return;
      suppressClick.current = false;
      drag.current = { id, x: event.clientX, y: event.clientY, started: false };
    },
  };
}
