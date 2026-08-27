import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// 预览窗口页面：通过一次性槽位从主窗口取图
export default function ImagePreview({ id }: { id: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<string>("take_pending_image", { id })
      .then(setDataUrl)
      .catch((e) => setError(String(e)));
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") getCurrentWindow().close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="preview-page">
      {error && <div className="preview-error">{error}</div>}
      {dataUrl ? (
        <img src={dataUrl} alt="预览" draggable={false} />
      ) : (
        !error && <div>加载中…</div>
      )}
      <div className="preview-hint">Esc 关闭 · 拖动边缘调整大小</div>
    </div>
  );
}
