import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconClose } from "./Icons";
interface Change {
  path: string;
  oldPath?: string;
  index: string;
  worktree: string;
}
interface Changes {
  root: string;
  branch: string;
  files: Change[];
}
export default function ChangesPanel({
  sessionId,
  cwd,
  onClose,
}: {
  sessionId: string;
  cwd?: string;
  onClose: () => void;
}) {
  const [path, setPath] = useState(cwd ?? "");
  const [result, setResult] = useState<Changes | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [diff, setDiff] = useState("");
  const [selected, setSelected] = useState<{
    path: string;
    kind: string;
  } | null>(null);
  const [panes, setPanes] = useState<
    { id: string; path: string; command: string }[]
  >([]);
  const request = useRef(0);
  const diffRequest = useRef(0);
  const refresh = async (directory = path) => {
    if (!sessionId || !directory) return;
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const next = await invoke<Changes>("workspace_changes", {
        sessionId,
        path: directory,
      });
      if (id !== request.current) return;
      setResult(next);
      setPath(next.root);
      setSelected(null);
      setDiff("");
      diffRequest.current++;
    } catch (e) {
      if (id === request.current) {
        setError(String(e));
        setResult(null);
        setSelected(null);
        setDiff("");
      }
    } finally {
      if (id === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (cwd) {
      setPath(cwd);
      void refresh(cwd);
    }
    return () => {
      request.current++;
      diffRequest.current++;
    };
  }, [sessionId, cwd]);
  const showDiff = async (file: Change, kind: string) => {
    if (!result) return;
    const id = ++diffRequest.current;
    setSelected({ path: file.path, kind });
    setDiff("正在读取差异…");
    setError("");
    try {
      const value = await invoke<string>("workspace_diff", {
        sessionId,
        root: result.root,
        path: file.path,
        kind,
      });
      if (id === diffRequest.current)
        setDiff(
          value || "此文件没有可显示的文本差异（可能是空文件或子模块变化）。",
        );
    } catch (e) {
      if (id === diffRequest.current) {
        setError(String(e));
        setDiff("");
      }
    }
  };
  return (
    <aside className="workspace-panel changes-panel">
      <header data-panel-drag-handle tabIndex={0}>
        <strong>代码修改</strong>
        <Button variant="ghost" size="icon-sm" title="关闭" onClick={onClose}>
          <IconClose />
        </Button>
      </header>
      <form
        className="workspace-actions"
        onSubmit={(e) => {
          e.preventDefault();
          void refresh();
        }}
      >
        <Input
          aria-label="Git 项目路径"
          placeholder="远程项目绝对路径"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <Button variant="outline" size="sm" disabled={loading || !path}>
          {loading ? "读取中…" : "刷新"}
        </Button>
      </form>
      <div className="workspace-actions">
        <Button
          variant="outline"
          size="sm"
          disabled={!cwd}
          onClick={() => cwd && void refresh(cwd)}
        >
          当前终端目录
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            try {
              const snapshot = await invoke<{ panes: typeof panes }>(
                "tmux_snapshot",
                { sessionId },
              );
              setPanes(snapshot.panes);
              if (!snapshot.panes.length)
                setError("未发现 tmux 窗格，请手动填写项目路径");
            } catch (e) {
              setError(String(e));
            }
          }}
        >
          选择 tmux 目录
        </Button>
      </div>
      {panes.length > 0 && (
        <div className="workspace-paths">
          {panes.map((p) => (
            <Button
              variant="outline"
              size="sm"
              key={p.id}
              onClick={() => {
                setPanes([]);
                void refresh(p.path);
              }}
            >
              {p.id} · {p.command} · {p.path}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="workspace-error">
          {error}
        </p>
      )}
      <p className="workspace-hint">
        展示整个 Git 工作区的当前修改，包含人工修改；不会自动归因给某个
        AI。点击刷新更新。
      </p>
      {result && (
        <>
          <div className="workspace-repo">
            {result.branch} · {result.files.length} 个修改项{" "}
            <small>{result.root}</small>
          </div>
          <div className="changes-files">
            {(["working", "staged", "untracked"] as const).map((kind) => {
              const files = result.files.filter((f) =>
                kind === "untracked"
                  ? f.index === "?"
                  : kind === "staged"
                    ? f.index !== " " && f.index !== "?"
                    : f.worktree !== " " && f.index !== "?",
              );
              return (
                <section key={kind}>
                  <h4>
                    {
                      {
                        working: "未暂存",
                        staged: "已暂存",
                        untracked: "新文件",
                      }[kind]
                    }{" "}
                    · {files.length}
                  </h4>
                  {files.map((file) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      className={
                        selected?.path === file.path && selected.kind === kind
                          ? "change-file-row selected"
                          : "change-file-row"
                      }
                      title={
                        file.oldPath
                          ? `${file.path}\n原路径：${file.oldPath}`
                          : file.path
                      }
                      key={file.path}
                      onClick={() => void showDiff(file, kind)}
                    >
                      <code>
                        {kind === "staged" ? file.index : file.worktree}
                      </code>
                      <span className="change-file-label">
                        <span className="change-file-path">{file.path}</span>
                        {file.oldPath && (
                          <small className="change-file-origin">
                            原路径：{file.oldPath}
                          </small>
                        )}
                      </span>
                    </Button>
                  ))}
                </section>
              );
            })}
            {!result.files.length && <p>工作区干净，没有修改。</p>}
          </div>
        </>
      )}
      {selected && (
        <div className="change-preview">
          <div className="workspace-repo">
            {selected.path}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelected(null);
                diffRequest.current++;
              }}
            >
              关闭差异
            </Button>
          </div>
          <pre aria-label="代码差异">
            {diff.split("\n").map((line, i) => (
              <div
                key={i}
                className={
                  line.startsWith("+")
                    ? "diff-add"
                    : line.startsWith("-")
                      ? "diff-remove"
                      : line.startsWith("@@")
                        ? "diff-hunk"
                        : ""
                }
              >
                {line || " "}
              </div>
            ))}
          </pre>
        </div>
      )}
    </aside>
  );
}
