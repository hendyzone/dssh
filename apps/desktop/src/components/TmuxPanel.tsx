import {
  X as UiX,
  Pencil as UiPencil,
  Download as UiDownload,
  RefreshCw as UiRefreshCw,
  ChevronRight,
  Folder,
} from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { PositionedMenu, MenuItem } from "./ui/positioned-menu";
import { IconClose } from "./Icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { TmuxSession, TmuxSnapshot } from "../lib/tmux";
import "./TmuxPanel.css";

const WORKER_GROUP = "Workers";
// Match worker tokens, not arbitrary project names containing "work".
const sessionGroup = (session: TmuxSession) => session.group ||
  (/(?:^|[-_])(?:cw\d+[a-z]*|worker\d*[a-z]*)(?=$|[-_])/i.test(session.name) ? WORKER_GROUP : "");

export default function TmuxPanel({
  sessionId,
  onAttach,
  onClose,
  attachedId,
  reuseTabs = true,
  onReuseTabsChange,
}: {
  sessionId: string;
  onAttach: (session: TmuxSession, forceNew?: boolean) => void;
  reuseTabs?: boolean;
  onReuseTabsChange?: (enabled: boolean) => void;
  onClose: () => void;
  attachedId?: string;
}) {
  const [snapshot, setSnapshot] = useState<TmuxSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState(attachedId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(()=>new Set([WORKER_GROUP]));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropGroup, setDropGroup] = useState<string | null>(null);
  const [swapId, setSwapId] = useState<string | null>(null);
  const drag = useRef<{ connectionId: string; session: TmuxSession; x: number; y: number; active: boolean } | null>(null);
  const suppressDragClick = useRef(false);
  const groupInputId = `tmux-groups-${sessionId}`;
  const groups = new Map<string, TmuxSession[]>();
  for (const session of snapshot?.sessions ?? []) {
    const group = sessionGroup(session);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(session);
  }
  if (groups.size && !groups.has("")) groups.set("", []);
  for (const sessions of groups.values()) {
    sessions.sort((a, b) => (a.order ?? Number(a.id.slice(1))) - (b.order ?? Number(b.id.slice(1))) || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  }
  const groupNames = [...groups.keys()].sort((a, b) =>
    !a ? 1 : !b ? -1 : a.localeCompare(b),
  );
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connectionId: string;
    session: TmuxSession;
  } | null>(null);
  useEffect(() => {
    if (
      contextMenu &&
      (contextMenu.connectionId !== sessionId ||
        !snapshot?.sessions.some(
          (s) =>
            s.id === contextMenu.session.id &&
            s.created === contextMenu.session.created,
        ))
    )
      setContextMenu(null);
  }, [contextMenu, sessionId, snapshot]);
  const [edit, setEdit] = useState<{
    action: string;
    target?: string;
    value: string;
  } | null>(null);
  const alive = useRef(true);
  const reading = useRef(false);
  const writing = useRef(false);
  const selected = snapshot?.sessions.find((s) => s.id === selectedId);
  useEffect(() => {
    // A disappeared or replaced session must not retarget an open rename/create form.
    setEdit(null);
  }, [selectedId, selected?.created]);
  const refresh = useCallback(
    async (silent = false) => {
      if (!sessionId || reading.current || writing.current) return;
      reading.current = true;
      if (!silent) setLoading(true);
      try {
        const next = await invoke<TmuxSnapshot>("tmux_snapshot", { sessionId });
        if (alive.current) {
          setSnapshot(next);
          setSelectedId((id) =>
            next.sessions.some((s) => s.id === id)
              ? id
              : (next.sessions[0]?.id ?? ""),
          );
          setError(null);
        }
      } catch (e) {
        if (alive.current) setError(String(e));
      } finally {
        reading.current = false;
        if (alive.current && !silent) setLoading(false);
      }
    },
    [sessionId],
  );
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(true), 5000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [refresh]);
  const run = async (
    action: string,
    target?: string,
    value?: string,
    subject = selected,
  ) => {
    if (writing.current || !sessionId) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    const scope = subject ? { id: subject.id, created: subject.created } : null;
    try {
      if (
        action.startsWith("kill-") &&
        !(await confirm(
          `确定结束此 tmux ${action === "kill-session" ? `会话「${subject?.name ?? ""}」` : action === "kill-window" ? "窗口" : "窗格"}吗？其中正在运行的进程将被终止。`,
          {
            title: "结束 tmux 任务",
            kind: "warning",
            okLabel: "结束任务",
            cancelLabel: "取消",
          },
        ))
      )
        return;
      if (!alive.current) return;
      await invoke("tmux_action", {
        sessionId,
        request: {
          action,
          target: target ?? null,
          name: value ?? null,
          session: scope,
        },
      });
      if (alive.current) {
        if (action === "set-group") {
          setCollapsedGroups((previous) => {
            const next = new Set(previous);
            next.delete(value ?? "");
            return next;
          });
        }
        setEdit(null);
        writing.current = false;
        await refresh(true);
      }
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      writing.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const panes = snapshot?.panes.filter((p) => p.sessionId === selectedId) ?? [];
  const windows = [...new Set(panes.map((p) => p.windowId))].map((id) =>
    panes.find((p) => p.windowId === id)!,
  );
  return (
    <aside className="tmux-panel" aria-label="tmux 管理">
      <header
        data-panel-drag-handle
        tabIndex={0}
        title="拖动标题栏到终端左侧或右侧停靠"
      >
        <strong>tmux</strong>
        <span>{snapshot?.version ?? "会话管理"}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          className="close-icon-btn"
          aria-label="关闭 tmux 面板"
        >
          <IconClose size={14} />
        </Button>
      </header>
      <div className="tmux-tools">
        <Button
          variant="outline"
          size="sm"
          disabled={!sessionId || busy || loading}
          onClick={() => void refresh()}
        >
          {loading ? "读取中…" : "刷新"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!snapshot?.installed || busy}
          onClick={() => setEdit({ action: "create-session", value: "" })}
        >
          新建会话
        </Button>
      </div>
      {onReuseTabsChange && (
        <label className="tmux-reuse-toggle">
          <input type="checkbox" checked={reuseTabs} onChange={(event) => onReuseTabsChange(event.target.checked)} />
          复用已打开的 tmux 标签页
        </label>
      )}
      {!sessionId && <p className="tmux-note">连接服务器后可管理 tmux。</p>}
      {error && (
        <p className="tmux-error" role="alert">
          {error}
        </p>
      )}
      {snapshot && !snapshot.installed && (
        <p className="tmux-note">
          远端未找到 tmux。请先在服务器上安装 tmux，再刷新。
        </p>
      )}
      {edit && (
        <form
          className="tmux-editor"
          onSubmit={(e) => {
            e.preventDefault();
            if (edit.action === "set-alias" || edit.action === "set-group" || edit.value.trim())
              void run(edit.action, edit.target, edit.value.trim());
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) {
              if (e.key === "Enter") e.preventDefault();
              return;
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setEdit(null);
            }
          }}
        >
          <label>
            {edit.action === "set-group"
              ? "分组名称（留空移至未分组）"
              : edit.action === "set-alias"
              ? "会话别名（留空清除）"
              : edit.action === "create-session"
              ? "新会话名称"
              : edit.action === "new-window"
                ? "新窗口名称"
                : "新名称"}
            <Input
              autoFocus
              aria-label={edit.action === "set-group" ? "tmux 分组" : edit.action === "set-alias" ? "tmux 别名" : "tmux 名称"}
              list={edit.action === "set-group" ? groupInputId : undefined}
              maxLength={64}
              value={edit.value}
              disabled={busy}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            />
          </label>
          {edit.action === "set-group" && (
            <>
              <datalist id={groupInputId}>
                {groupNames.filter(Boolean).map((name) => <option key={name} value={name} />)}
              </datalist>
              <p className="tmux-note">选择已有分组或输入新名称，同一远端 tmux 服务的 SSH 连接共享分组。</p>
            </>
          )}
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || (edit.action !== "set-alias" && edit.action !== "set-group" && !edit.value.trim())}
              type="submit"
            >
              {busy ? "处理中…" : "确定"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => setEdit(null)}
            >
              取消
            </Button>
          </div>
        </form>
      )}
      {snapshot?.installed && (
        <>
          <div className="tmux-session-list">
            {groupNames.map((group) => (
              <section className={`tmux-group${dropGroup === group ? " drop-target" : ""}`} data-tmux-group={group} key={group}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="tmux-group-toggle"
                  aria-expanded={!collapsedGroups.has(group)}
                  onClick={() => setCollapsedGroups((previous) => {
                    const next = new Set(previous);
                    if (next.has(group)) next.delete(group);
                    else next.add(group);
                    return next;
                  })}
                >
                  <ChevronRight className="tmux-group-chevron" size={14} aria-hidden="true" />
                  <Folder className="tmux-group-icon" size={16} aria-hidden="true" />
                  <strong>{group || "未分组"}</strong>
                  <span className="tmux-group-count">{groups.get(group)!.length}</span>
                </Button>
                {!collapsedGroups.has(group) && (
                  <div className="tmux-group-sessions">
                {!collapsedGroups.has(group) && groups.get(group)!.map((s) => (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={`tmux-session-card${s.id === selectedId ? " selected" : ""}${draggingId === s.id ? " dragging" : ""}${swapId === s.id ? " swap-target" : ""}`}
                    data-tmux-session={s.id}
                    key={s.id}
                    title="双击进入会话，拖到同组会话交换位置，拖到文件夹更改分组"
                    onDragStart={(event) => event.preventDefault()}
                    onPointerDown={(event) => {
                      if (busy || event.button !== 0) return;
                      suppressDragClick.current = false;
                      drag.current = { connectionId: sessionId, session: s, x: event.clientX, y: event.clientY, active: false };
                      event.currentTarget.setPointerCapture(event.pointerId);
                    }}
                    onPointerMove={(event) => {
                      const current = drag.current;
                      if (!current || current.connectionId !== sessionId || busy) return;
                      if (!current.active && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 6) return;
                      current.active = true;
                      suppressDragClick.current = true;
                      setDraggingId(current.session.id);
                      setContextMenu(null);
                      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tmux-group]");
                      setDropGroup(target && event.currentTarget.closest(".tmux-panel")?.contains(target) ? target.dataset.tmuxGroup ?? null : null);
                      const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tmux-session]");
                      setSwapId(target && event.currentTarget.closest(".tmux-panel")?.contains(target) && target.dataset.tmuxGroup === sessionGroup(current.session) && card?.dataset.tmuxSession !== current.session.id ? card?.dataset.tmuxSession ?? null : null);
                    }}
                    onPointerUp={(event) => {
                      const current = drag.current;
                      drag.current = null;
                      setDraggingId(null);
                      setDropGroup(null);
                      setSwapId(null);
                      if (!current?.active || current.connectionId !== sessionId || busy) return;
                      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tmux-group]");
                      const group = target?.dataset.tmuxGroup;
                      const subject = snapshot.sessions.find((item) => item.id === current.session.id && item.created === current.session.created);
                      const card = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-tmux-session]");
                      const other = snapshot.sessions.find((item) => item.id === card?.dataset.tmuxSession);
                      if (subject && other && other.id !== subject.id && target && event.currentTarget.closest(".tmux-panel")?.contains(target) && (other.group || "") === (subject.group || "")) {
                        void run("swap-session", other.id, String(other.created), subject);
                        return;
                      }
                      if (subject && target && event.currentTarget.closest(".tmux-panel")?.contains(target) && group !== undefined && group !== sessionGroup(subject)) {
                        void run("set-group", undefined, group, subject);
                      }
                    }}
                    onLostPointerCapture={() => {
                      setSwapId(null);
                      drag.current = null;
                      setDraggingId(null);
                      setDropGroup(null);
                    }}
                    onPointerCancel={() => {
                      setSwapId(null);
                      drag.current = null;
                      setDraggingId(null);
                      setDropGroup(null);
                    }}
                    onDoubleClick={() => {
                      if (!busy && !suppressDragClick.current) onAttach(s);
                    }}
                    disabled={busy}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (busy) return;
                      setSelectedId(s.id);
                      setEdit(null);
                      setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        connectionId: sessionId,
                        session: s,
                      });
                    }}
                    onClick={() => {
                      if (suppressDragClick.current) return;
                      setContextMenu(null);
                      setSelectedId(s.id);
                      setEdit(null);
                    }}
                  >
                    <strong>{s.alias || s.name}</strong>
                    {s.alias && <small>原名：{s.name}</small>}
                    <small>
                      {s.windows} 个窗口 · {s.attached} 个客户端
                      {s.id === attachedId ? " · 当前附加" : ""}
                    </small>
                  </Button>
                ))}
                    {!groups.get(group)!.length && <p className="tmux-group-empty">拖动会话到此处</p>}
                  </div>
                )}
              </section>
            ))}
            {!snapshot.sessions.length && (
              <p className="tmux-note">
                暂无会话，创建后即使 SSH 断开，任务也会继续运行。
              </p>
            )}
          </div>
          {selected && (
            <>
              <section className="tmux-details">
                <Button
                  variant="ghost"
                  size="sm"
                  className="tmux-details-toggle"
                  aria-expanded={detailsExpanded}
                  onClick={() => setDetailsExpanded((expanded) => !expanded)}
                >
                  <ChevronRight size={14} aria-hidden="true" />
                  <strong>窗口与窗格</strong>
                  <span>{detailsExpanded ? "收起" : "展开"}</span>
                </Button>
                {detailsExpanded && (
                  <div className="tmux-details-content">
                    <div className="tmux-tools">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          setEdit({ action: "new-window", value: "" })
                        }
                      >
                        新建窗口
                      </Button>
                    </div>
                    <div className="tmux-tools">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => void run("enable-mouse")}
                      >
                        启用 tmux 鼠标
                      </Button>
                    </div>
                    <div className="tmux-windows">
                      {windows.map((w) => (
                        <section key={w.windowId}>
                          <div className="tmux-window-heading">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy}
                              className={w.windowActive ? "selected" : ""}
                              onClick={() =>
                                void run("select-window", w.windowId)
                              }
                            >
                              {w.windowIndex}: {w.windowName}
                              {w.windowActive ? " ●" : ""}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              title="重命名窗口"
                              disabled={busy}
                              onClick={() =>
                                setEdit({
                                  action: "rename-window",
                                  target: w.windowId,
                                  value: w.windowName,
                                })
                              }
                            >
                              改名
                            </Button>
                            <Button
                              variant="destructive"
                              size="icon-sm"
                              title="结束窗口"
                              className="danger"
                              disabled={busy}
                              onClick={() =>
                                void run("kill-window", w.windowId)
                              }
                            >
                              <UiX size={14} />
                            </Button>
                          </div>
                          {panes
                            .filter((p) => p.windowId === w.windowId)
                            .map((p) => (
                              <div
                                className={`tmux-pane ${p.active ? "active" : ""}`}
                                key={p.id}
                              >
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy}
                                  className="tmux-pane-select"
                                  onClick={() => void run("select-pane", p.id)}
                                  title="选择远端窗格"
                                >
                                  <strong>
                                    {p.index}: {p.command || "shell"}
                                    {p.active ? " ●" : ""}
                                  </strong>
                                  <small title={p.path}>{p.path || "—"}</small>
                                </Button>
                                <div className="tmux-pane-actions">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void run("copy-mode", p.id)}
                                  >
                                    复制模式
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={busy}
                                    title="需要 tmux 3.3+ 及应用支持转义封装"
                                    onClick={() =>
                                      void run("enable-passthrough", p.id)
                                    }
                                  >
                                    图片透传
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      void run("split-horizontal", p.id)
                                    }
                                  >
                                    左右分屏
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() =>
                                      void run("split-vertical", p.id)
                                    }
                                  >
                                    上下分屏
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void run("zoom-pane", p.id)}
                                  >
                                    {p.zoomed ? "还原" : "放大"}
                                  </Button>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    disabled={busy}
                                    className="danger"
                                    onClick={() => void run("kill-pane", p.id)}
                                  >
                                    结束
                                  </Button>
                                </div>
                              </div>
                            ))}
                        </section>
                      ))}
                    </div>
                    <p className="tmux-note">
                      管理当前用户的默认 tmux 服务，每 5
                      秒刷新。选择窗口和窗格会影响共享此会话的客户端。
                    </p>
                    <p className="tmux-note">
                      关闭附加标签只分离客户端；“结束”会终止远端任务。默认快捷键：Ctrl+B
                      后按 D 分离、C 新窗口、[
                      进入复制模式；自定义配置以远端设置为准。
                    </p>
                  </div>
                )}
              </section>
            </>
          )}
        </>
      )}
      {contextMenu && contextMenu.connectionId === sessionId && (
        <PositionedMenu
          x={contextMenu.x}
          y={contextMenu.y}
          label="tmux 会话操作"
          onClose={() => setContextMenu(null)}
        >
          <MenuItem disabled={busy} onClick={() => {
            onAttach(contextMenu.session, true);
            setContextMenu(null);
          }}>
            在新标签页中打开
          </MenuItem>
          <MenuItem
            disabled={busy}
            onClick={() => {
              setEdit({ action: "set-group", value: contextMenu.session.group ?? "" });
              setContextMenu(null);
            }}
          >
            <Folder size={14} />
            设置分组
          </MenuItem>
          <MenuItem
            disabled={busy}
            onClick={() => {
              setEdit({ action: "rename-session", value: contextMenu.session.name });
              setContextMenu(null);
            }}
          >
            <UiPencil size={14} />
            重命名会话
          </MenuItem>
          <MenuItem
            disabled={busy}
            onClick={() => {
              setEdit({ action: "set-alias", value: contextMenu.session.alias ?? "" });
              setContextMenu(null);
            }}
          >
            <UiPencil size={14} />
            设置别名
          </MenuItem>
          <MenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => {
              const subject = contextMenu.session;
              setContextMenu(null);
              void run("kill-session", undefined, undefined, subject);
            }}
          >
            <UiX size={14} />
            结束会话
          </MenuItem>
        </PositionedMenu>
      )}
    </aside>
  );
}
