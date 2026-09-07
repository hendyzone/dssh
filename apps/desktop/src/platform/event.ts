export type UnlistenFn = () => void;
export interface Event<T> { event: string; payload: T; }
export async function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<UnlistenFn> {
  if (!window.dssh) throw new Error("请使用 Electron 启动 dssh");
  if (event === "desktop://drag-drop") {
    const dragover = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files, file => window.dssh!.filePath(file)).filter(Boolean);
      handler({ event, payload: { paths, position: { x: e.clientX * devicePixelRatio, y: e.clientY * devicePixelRatio } } as T });
    };
    window.addEventListener("dragover", dragover);
    window.addEventListener("drop", drop);
    return () => { window.removeEventListener("dragover", dragover); window.removeEventListener("drop", drop); };
  }
  return window.dssh.listen(event, payload => handler({ event, payload: payload as T }));
}
