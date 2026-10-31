import { useState, type DragEvent } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import PanelIcon from "./PanelIcon";
import type { PanelDefinition, PanelId, PanelSide } from "../lib/sidePanelLayout";
import "./IconRail.css";

/** One generic icon rail; both sides use it and panels keep their contents untouched. */
export default function IconRail({side, items, active, onSelect, onMove}: {
  side: PanelSide;
  items: PanelDefinition[];
  active: string | null;
  onSelect: (id: PanelId) => void;
  onMove: (id: PanelId, side: PanelSide, index: number) => void;
}) {
  const [dragging, setDragging] = useState<PanelId | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const actionLabel = (item: PanelDefinition) => item.id === "connections"
    ? (active === "connections" ? "隐藏连接面板" : "显示连接面板")
    : item.label;
  const end = () => { setDragging(null); setDropIndex(null); };
  const indexAt = (event: DragEvent<HTMLElement>) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-panel-icon]")];
    const hovered = (event.target as Element | null)?.closest?.("[data-panel-icon]");
    const hoveredIndex = hovered ? buttons.indexOf(hovered as HTMLElement) : -1;
    for (let index = 0; index < buttons.length; index++) {
      if (index === hoveredIndex) continue;
      const rect = buttons[index].getBoundingClientRect();
      if (rect.height > 0 && event.clientY < rect.top + rect.height / 2) return index;
    }
    if (hoveredIndex >= 0) return hoveredIndex;
    return buttons.length;
  };
  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const id = (event.dataTransfer.getData("application/x-dssh-panel") || dragging) as PanelId | "";
    if (!id) { end(); return; }
    // Compute from this event: dragOver state may not have rendered before drop.
    onMove(id, side, dropIndex ?? indexAt(event));
    end();
  };
  return <TooltipProvider delayDuration={350}>
    <nav className={`tool-rail icon-rail icon-rail-${side}${dragging ? " is-dragging" : ""}${dropIndex !== null ? " has-drop" : ""}`}
      aria-label={side === "left" ? "左侧工具" : "右侧工具"}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropIndex(indexAt(event)); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropIndex(null); }}
      onDrop={drop}>
      {items.map((item, index) => (
        <div key={item.id} className={`icon-rail-slot${dropIndex === index ? " is-drop-before" : ""}${index === items.length - 1 && dropIndex === items.length ? " is-drop-after" : ""}`}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" data-panel-icon={item.id}
                className={active === item.id ? "active" : ""} aria-pressed={active === item.id}
                aria-label={item.label} title={actionLabel(item)}
                draggable onDragStart={event => {
                  setDragging(item.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("application/x-dssh-panel", item.id);
                }} onDragEnd={end}
                onClick={() => onSelect(item.id)}>
                <PanelIcon id={item.id}/>
              </Button>
            </TooltipTrigger>
            <TooltipContent side={side === "right" ? "left" : "right"} sideOffset={10}>{actionLabel(item)}</TooltipContent>
          </Tooltip>
        </div>
      ))}
    </nav>
  </TooltipProvider>;
}
