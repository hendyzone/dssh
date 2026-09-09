import {
  X as UiX,
  Pencil as UiPencil,
  Download as UiDownload,
  RefreshCw as UiRefreshCw,
  ChevronRight,
} from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { IconClose } from "./Icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm } from "@tauri-apps/plugin-dialog";
import type { TmuxSession, TmuxSnapshot } from "../lib/tmux";
import "./TmuxPanel.css";

export default function TmuxPanel({
  sessionId,
  onAttach,
  onClose,
  attachedId,
}: {
  sessionId: string;
  onAttach: (session: TmuxSession) => void;
  onClose: () => void;
  attachedId?: string;
}) {
  const [snapshot, setSnapshot] = useState<TmuxSnapshot | null>(null);
  const [selectedId, setSelectedId] = useState(attachedId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
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
  const run = async (action: string, target?: string, value?: string) => {
    if (writing.current || !sessionId) return;
    writing.current = true;
    setBusy(true);
    setError(null);
    const scope = selected
      ? { id: selected.id, created: selected.created }
      : null;
    try {
      if (
        action.startsWith("kill-") &&
        !(await confirm(
          `确定结束此 tmux ${action === "kill-session" ? "会话" : action === "kill-window" ? "窗口" : "窗格"}吗？其中正在运行的进程将被终止。`,
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
            if (edit.value.trim())
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
            {edit.action === "create-session"
              ? "新会话名称"
              : edit.action === "new-window"
                ? "新窗口名称"
                : "新名称"}
            <Input
              autoFocus
              aria-label="tmux 名称"
              maxLength={64}
              value={edit.value}
              disabled={busy}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            />
          </label>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !edit.value.trim()}
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
            {snapshot.sessions.map((s) => (
              <Button
                variant="ghost"
                size="sm"
                className={s.id === selectedId ? "selected" : ""}
                key={s.id}
                title="双击进入此 tmux 会话"
                onDoubleClick={() => {
                  if (!busy) onAttach(s);
                }}
                disabled={busy}
                onClick={() => {
                  setSelectedId(s.id);
                  setEdit(null);
                }}
              >
                <strong>{s.name}</strong>
                <small>
                  {s.windows} 个窗口 · {s.attached} 个客户端
                  {s.id === attachedId ? " · 当前附加" : ""}
                </small>
              </Button>
            ))}
            {!snapshot.sessions.length && (
              <p className="tmux-note">
                暂无会话，创建后即使 SSH 断开，任务也会继续运行。
              </p>
            )}
          </div>
          {selected && (
            <>
              <div className="tmux-tools">
                <Button
                  variant="outline"
                  size="sm"
                  className="tmux-enter"
                  disabled={busy}
                  onClick={() => onAttach(selected)}
                >
                  进入会话
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setEdit({ action: "rename-session", value: selected.name })
                  }
                >
                  重命名会话
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy}
                  className="danger"
                  onClick={() => void run("kill-session")}
                >
                  结束会话
                </Button>
              </div>
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
    </aside>
  );
}
