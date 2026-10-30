import { useState, type DragEvent } from "react";
import { Button } from "./ui/button";
import PanelIcon from "./PanelIcon";
import {
  canHidePanel, defaultLayout, panelsOnSide, placePanel, setPanelHidden, setPanelSide,
  type PanelLayout, type PanelSide,
} from "../lib/sidePanelLayout";
import "./SidePanelSettings.css";

/** Settings section for the two icon rails: side, visibility, order (drag the grip). */
export default function SidePanelSettings({layout, onChange}: {
  layout: PanelLayout;
  onChange: (next: PanelLayout) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const rows = [...panelsOnSide(layout, "left"), ...panelsOnSide(layout, "right")];
  const drop = (event: DragEvent<HTMLElement>, id: string) => {
    event.preventDefault();
    const source = event.dataTransfer.getData("text/plain") || dragging;
    if (!source || source === id) { setDragging(null); setDropTarget(null); return; }
    const side = layout[id].side;
    const index = panelsOnSide(layout, side).findIndex(item => item.id === id);
    onChange(placePanel(layout, source, side, index));
    setDragging(null); setDropTarget(null);
  };
  const sideButton = (id: string, side: PanelSide, label: string) =>
    <Button variant="ghost" size="sm" aria-pressed={layout[id].side === side}
      aria-label={`${label} ${layout[id].side === side ? "（当前）" : ""}`.trim()}
      onClick={() => onChange(setPanelSide(layout, id, side))}>{label}</Button>;
  return <div className="side-panel-settings">
    <div className="side-panel-settings-head">
      <strong>侧栏</strong>
      <Button variant="outline" size="sm" onClick={() => onChange(defaultLayout())}>恢复默认</Button>
    </div>
    <ul className="side-panel-settings-list" aria-label="侧栏面板">
      {rows.map(item => {
        const pref = layout[item.id];
        return <li key={item.id} data-panel-row={item.id}
          className={`side-panel-settings-row${dragging === item.id ? " is-dragging" : ""}${dropTarget === item.id ? " is-drop-target" : ""}`}
          draggable onDragStart={event => { setDragging(item.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", item.id); }}
          onDragEnd={() => { setDragging(null); setDropTarget(null); }}
          onDragOver={event => { event.preventDefault(); setDropTarget(item.id); }}
          onDragLeave={() => setDropTarget(previous => previous === item.id ? null : previous)}
          onDrop={event => drop(event, item.id)}>
          <span className="side-panel-settings-grip" aria-hidden="true" title="拖动排序">⠿</span>
          <span className="side-panel-settings-icon" aria-hidden="true"><PanelIcon id={item.id}/></span>
          <span className="side-panel-settings-name">{item.label}</span>
          <span className="side-panel-settings-side" role="group" aria-label={`${item.label} 位置`}>
            {sideButton(item.id, "left", "左")}
            {sideButton(item.id, "right", "右")}
          </span>
          <label className="side-panel-settings-show">
            <input type="checkbox" checked={!pref.hidden} disabled={!canHidePanel(layout, item.id)}
              aria-label={`显示 ${item.label}`}
              onChange={event => onChange(setPanelHidden(layout, item.id, !event.target.checked))}/>
            显示
          </label>
        </li>;
      })}
    </ul>
  </div>;
}
