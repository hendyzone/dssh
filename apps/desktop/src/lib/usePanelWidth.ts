import { useEffect, useRef, useState } from "react";

export function usePanelWidth(kind: string, side: "left" | "right") {
  const element = useRef<HTMLElement>(null);
  const key = `dssh.panel-width.${kind}`;
  const defaultWidth = kind === "changes" ? 740 : 390;
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key));
      return Number.isFinite(saved) && saved >= 260 ? saved : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const [maximum, setMaximum] = useState(
    Math.max(260, window.innerWidth - 320),
  );
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const clamp = (value: number) =>
    Math.round(Math.max(260, Math.min(maximum, value)));
  const update = (value: number) => {
    const next = clamp(value);
    setWidth(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* Keep working in memory. */
    }
  };
  const finish = () => {
    drag.current = null;
    setResizing(false);
  };
  useEffect(() => {
    const parent = element.current?.parentElement;
    const measure = () => {
      const available = parent?.getBoundingClientRect().width;
      if (available) setMaximum(Math.max(260, available - 240));
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    if (parent) observer?.observe(parent);
    window.addEventListener("resize", measure);
    window.addEventListener("blur", finish);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("blur", finish);
    };
  }, []);
  return {
    element,
    width: clamp(width),
    resizing,
    separatorProps: {
      role: "separator",
      tabIndex: 0,
      "aria-label": "调整工具面板宽度",
      "aria-orientation": "vertical" as const,
      "aria-valuemin": 260,
      "aria-valuemax": maximum,
      "aria-valuenow": clamp(width),
      title: "拖动调整宽度，双击恢复默认；方向键微调",
      onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          x: event.clientX,
          width: clamp(width),
        };
        setResizing(true);
      },
      onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
        if (drag.current?.id !== event.pointerId) return;
        event.stopPropagation();
        update(
          drag.current.width +
            (event.clientX - drag.current.x) * (side === "right" ? -1 : 1),
        );
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick: () => update(defaultWidth),
      onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        event.stopPropagation();
        update(
          event.key === "Home"
            ? 260
            : event.key === "End"
              ? maximum
              : clamp(width) +
                (event.key === "ArrowRight" ? 1 : -1) *
                  (side === "right" ? -1 : 1) *
                  (event.shiftKey ? 40 : 10),
        );
      },
    },
  };
}
