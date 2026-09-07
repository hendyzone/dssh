//! 图片预览窗口：主窗口存入待预览图片 → 新窗口取出显示

use std::collections::HashMap;
use std::sync::Mutex;

use tauri::{AppHandle, State, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
pub struct PreviewState {
    /// dataURL 可能有几 MB，用一次性槽位传递，取出即删
    pending: Mutex<HashMap<String, String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum PreviewError {
    #[error("{0}")]
    Other(String),
}

impl serde::Serialize for PreviewError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/// 主窗口调用：存图并打开预览窗口
#[tauri::command]
pub async fn open_image_preview(
    app: AppHandle,
    state: State<'_, PreviewState>,
    data_url: String,
    width: u32,
    height: u32,
) -> Result<(), PreviewError> {
    let id = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    state
        .pending
        .lock()
        .map_err(|e| PreviewError::Other(e.to_string()))?
        .insert(id.clone(), data_url);

    let label = format!("preview-{id}");
    // 窗口尺寸 = 图片尺寸 + 边距，限制在合理范围
    let w = (width + 48).clamp(320, 1400) as f64;
    let h = (height + 88).clamp(240, 1000) as f64;

    WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("index.html#/preview/{id}").into()),
    )
    .title("dssh 图片预览")
    .inner_size(w, h)
    .resizable(true)
    .build()
    .map_err(|e| PreviewError::Other(e.to_string()))?;

    Ok(())
}

/// 预览窗口调用：取出图片（一次性）
#[tauri::command]
pub async fn take_pending_image(
    state: State<'_, PreviewState>,
    id: String,
) -> Result<String, PreviewError> {
    state
        .pending
        .lock()
        .map_err(|e| PreviewError::Other(e.to_string()))?
        .remove(&id)
        .ok_or_else(|| PreviewError::Other("图片不存在或已被取出".into()))
}
