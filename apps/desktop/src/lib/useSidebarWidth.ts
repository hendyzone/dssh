import { useEffect, useRef, useState } from "react";

const STORAGE_KEY = "dssh.sidebar.width";
const DEFAULT_WIDTH = 264;
const MIN_WIDTH = 220;
const maximum = () =>
  Math.max(MIN_WIDTH, Math.min(600, window.innerWidth - 360));
const clamp = (width: number) =>
  Math.round(Math.max(MIN_WIDTH, Math.min(maximum(), width)));

export function useSidebarWidth() {
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(STORAGE_KEY));
      return clamp(Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_WIDTH);
    } catch {
      return clamp(DEFAULT_WIDTH);
    }
  });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const update = (next: number) => {
    const value = clamp(next);
    setWidth(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      /* Resizing still works without storage. */
    }
  };
  useEffect(() => {
    const resize = () => setWidth((current) => clamp(current));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const finish = () => {
    drag.current = null;
    setDragging(false);
  };
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => window.removeEventListener("blur", finish);
  }, []);
  return {
    width,
    dragging,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": "调整左栏宽度",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": MIN_WIDTH,
      "aria-valuemax": maximum(),
      "aria-valuenow": width,
      title: "拖动调整左栏宽度，双击恢复默认；方向键微调",
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width };
        setDragging(true);
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        const start = drag.current;
        if (start?.pointerId === event.pointerId)
          update(start.width + event.clientX - start.x);
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick: () => update(DEFAULT_WIDTH),
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        update(
          event.key === "Home"
            ? MIN_WIDTH
            : event.key === "End"
              ? maximum()
              : width +
                (event.key === "ArrowRight" ? 1 : -1) *
                  (event.shiftKey ? 40 : 10),
        );
      },
    },
  };
}
