import { AppDialog } from "./ui/app-dialog";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { FolderPlus, Plus } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { TabInfo } from "../types";
import { GROUP_COLORS, type ConnectionGroup } from "../lib/connectionGroups";
import { useDialogFocus } from "../lib/useDialogFocus";
import { isComposingKey } from "../lib/keyboard";
import "./ConnectionGroups.css";

export function ConnectionTabStrip({
  tabs,
  groups,
  activeTabId,
  renderTab,
  onToggle,
  onEdit,
  onCreate,
  onNewTab,
  onMove,
}: {
  tabs: TabInfo[];
  groups: ConnectionGroup[];
  activeTabId: string | null;
  renderTab: (tab: TabInfo) => ReactNode;
  onToggle: (id: string) => void;
  onEdit: (group: ConnectionGroup) => void;
  onCreate: () => void;
  onNewTab: () => void;
  onMove: (tabId: string, groupId?: string) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>('.tab[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeTabId, tabs]);
  const rendered = new Set<string>();
  const renderGroup = (group: ConnectionGroup) => {
    rendered.add(group.id);
    const members = tabs.filter((t) => t.groupId === group.id);
    return (
      <div
        key={group.id}
        className="connection-group"
        style={{ "--group-color": group.color } as CSSProperties}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("application/x-dssh-tab")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const id = event.dataTransfer.getData("application/x-dssh-tab");
          if (tabs.some((t) => t.id === id)) onMove(id, group.id);
        }}
      >
        <div
          className="connection-group-heading"
          onContextMenu={(event) => {
            event.preventDefault();
            onEdit(group);
          }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="connection-group-toggle"
            aria-expanded={!group.collapsed}
            title={
              group.collapsed ? "展开分组（折叠时保留当前连接）" : "折叠分组"
            }
            aria-label={`${group.collapsed ? "展开" : "折叠"}分组 ${group.name}`}
            onClick={() => onToggle(group.id)}
          >
            <span aria-hidden="true">{group.collapsed ? "▸" : "▾"}</span>
            <span className="connection-group-name">{group.name}</span>
            <span className="connection-group-count">{members.length}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="connection-group-edit"
            aria-label={`管理分组 ${group.name}`}
            onClick={() => onEdit(group)}
          >
            ⋯
          </Button>
        </div>
        {members
          .filter((t) => !group.collapsed || t.id === activeTabId)
          .map(renderTab)}
      </div>
    );
  };
  return (
    <div
      ref={stripRef}
      className="tab-bar connection-tab-bar"
      role="tablist"
      aria-label="已打开的连接"
    >
      {tabs.map((tab) => {
        const group = groups.find((g) => g.id === tab.groupId);
        if (!group) return renderTab(tab);
        return rendered.has(group.id) ? null : renderGroup(group);
      })}
      {groups.filter((g) => !rendered.has(g.id)).map(renderGroup)}
      <Button
        variant="ghost"
        size="sm"
        className="tab-new"
        aria-label="新建标签"
        title="新建标签 (⌘T / Ctrl+T)"
        onClick={onNewTab}
      >
        <Plus size={16} aria-hidden="true" />
      </Button>
      {tabs.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          className="connection-create"
          aria-label="新建分组"
          onClick={onCreate}
          title="新建分组：将当前连接加入新分组"
        >
          <FolderPlus size={16} aria-hidden="true" />
        </Button>
      )}
      {groups.length > 0 && (
        <span
          className="connection-ungroup-drop"
          title="将连接拖到此处移出分组"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("application/x-dssh-tab"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const id = event.dataTransfer.getData("application/x-dssh-tab");
            if (tabs.some((t) => t.id === id)) onMove(id);
          }}
        >
          拖到此处移出分组
        </span>
      )}
    </div>
  );
}

export function ConnectionGroupEditor({
  group,
  onSave,
  onCancel,
  onUngroup,
  onCloseGroup,
}: {
  group?: ConnectionGroup;
  onSave: (name: string, color: string) => void;
  onCancel: () => void;
  onUngroup?: () => void;
  onCloseGroup?: () => void;
}) {
  const [name, setName] = useState(group?.name ?? "");
  const [color, setColor] = useState(group?.color ?? GROUP_COLORS[0].value);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <AppDialog title="连接分组" onClose={onCancel} busy={false}>
      <div
        ref={ref}
        className="modal connection-group-dialog"
        aria-labelledby="connection-group-title"
        tabIndex={-1}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !isComposingKey(e.nativeEvent)) {
            e.stopPropagation();
            onCancel();
          }
        }}
      >
        <h3 id="connection-group-title">
          {group ? "管理连接分组" : "新建连接分组"}
        </h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onSave(name.trim(), color);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && isComposingKey(e.nativeEvent))
              e.preventDefault();
          }}
        >
          <label className="connection-group-label">
            分组名称
            <Input
              autoFocus
              maxLength={32}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例如：生产环境、开发、数据库"
            />
          </label>
          <fieldset className="connection-colors">
            <legend>分组颜色</legend>
            {GROUP_COLORS.map((c) => (
              <label
                key={c.value}
                title={c.name}
                style={{ "--group-color": c.value } as CSSProperties}
              >
                <input
                  type="radio"
                  name="group-color"
                  value={c.value}
                  checked={color === c.value}
                  onChange={() => setColor(c.value)}
                  aria-label={c.name}
                />
                <span />
              </label>
            ))}
          </fieldset>
          <p className="connection-group-hint">
            用于管理当前窗口已打开的连接。折叠和移动分组会保留 SSH 会话。
          </p>
          <div className="form-actions">
            <Button
              variant="outline"
              size="sm"
              type="button"
              className="btn-secondary"
              onClick={onCancel}
            >
              取消
            </Button>
            <Button
              variant="default"
              size="sm"
              type="submit"
              className="btn-primary"
              disabled={!name.trim()}
            >
              {group ? "保存" : "创建分组"}
            </Button>
          </div>
        </form>
        {group && (
          <div className="connection-group-actions">
            <Button variant="outline" size="sm" onClick={onUngroup}>
              解散分组，保留连接
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="danger"
              onClick={onCloseGroup}
            >
              关闭组内全部连接
            </Button>
          </div>
        )}
      </div>
    </AppDialog>
  );
}
