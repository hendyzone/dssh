import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePanelWidth } from "../lib/usePanelWidth";

export default function PanelDock({
  kind,
  children,
}: {
  kind: string;
  children: ReactNode;
}) {
  const key = `dssh.panel-side.${kind}`;
  const drag = useRef<{
    started: boolean;
    id: number;
    x: number;
    y: number;
    bounds: DOMRect;
    target: "left" | "right" | null;
  } | null>(null);
  const [preview, setPreview] = useState<{
    bounds: DOMRect;
    target: "left" | "right" | null;
  } | null>(null);
  const cancel = () => {
    drag.current = null;
    setPreview(null);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") cancel();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancel);
    };
  }, []);
  const [side, setSide] = useState<"left" | "right">(() => {
    try {
      return localStorage.getItem(key) === "left" ? "left" : "right";
    } catch {
      return "right";
    }
  });
  useEffect(() => {
    const sync = () => {
      try {
        setSide(localStorage.getItem(key) === "left" ? "left" : "right");
      } catch {}
    };
    window.addEventListener("dssh-panel-position", sync);
    return () => window.removeEventListener("dssh-panel-position", sync);
  }, [key]);
  const sizing = usePanelWidth(kind, side);
  const move = (value: "left" | "right") => {
    setSide(value);
    try {
      localStorage.setItem(key, value);
      window.dispatchEvent(new Event("dssh-panel-position"));
    } catch {
      /* Keep current position without persistence. */
    }
  };
  return (
    <section
      ref={sizing.element}
      style={{ width: sizing.width }}
      className={`panel-dock panel-dock-${side}${sizing.resizing ? " is-resizing" : ""}`}
      aria-label={`${kind} 停靠面板`}
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (
          event.button !== 0 ||
          !target.closest("[data-panel-drag-handle]") ||
          target.closest("button,input,select")
        )
          return;
        const bounds =
          event.currentTarget.parentElement!.getBoundingClientRect();
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          started: false,
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          bounds,
          target: null,
        };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (
          !start ||
          start.id !== event.pointerId ||
          (!start.started &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8)
        )
          return;
        start.started = true;
        const b = start.bounds;
        const inside =
          event.clientY >= b.top &&
          event.clientY <= b.bottom &&
          event.clientX >= b.left &&
          event.clientX <= b.right;
        start.target = !inside
          ? null
          : event.clientX < b.left + b.width * 0.35
            ? "left"
            : event.clientX > b.right - b.width * 0.35
              ? "right"
              : null;
        setPreview({ bounds: b, target: start.target });
      }}
      onPointerUp={(event) => {
        if (drag.current?.id === event.pointerId && drag.current.target)
          move(drag.current.target);
        cancel();
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (
          !(event.target as Element).matches("[data-panel-drag-handle]") ||
          !event.altKey
        )
          return;
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          event.stopPropagation();
          move(event.key === "ArrowLeft" ? "left" : "right");
        }
      }}
    >
      <div className="panel-width-handle" {...sizing.separatorProps} />
      {children}
      {preview &&
        createPortal(
          <div className="dock-drag-overlay">
            {(["left", "right"] as const).map((position) => (
              <div
                key={position}
                className={`dock-drop-zone${preview.target === position ? " active" : ""}`}
                style={{
                  top: preview.bounds.top + 8,
                  height: preview.bounds.height - 16,
                  left:
                    position === "left"
                      ? preview.bounds.left + 8
                      : preview.bounds.right -
                        Math.min(300, preview.bounds.width * 0.3) -
                        8,
                  width: Math.min(300, preview.bounds.width * 0.3),
                }}
              >
                {position === "left" ? "松开固定到左侧" : "松开固定到右侧"}
              </div>
            ))}
          </div>,
          document.body,
        )}
    </section>
  );
}
