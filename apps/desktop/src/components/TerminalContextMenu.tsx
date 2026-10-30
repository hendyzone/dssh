import { PositionedMenu, MenuItem } from "./ui/positioned-menu";
import { createPortal } from "react-dom";

export interface TerminalMenuPosition {
  x: number;
  y: number;
  selection: string;
}

export default function TerminalContextMenu({
  position,
  canPaste,
  onCopy,
  onOpenPage,
  download,
  onCopyTmux,
  onPaste,
  onPasteImage,
  onSelectAll,
  onClose,
}: {
  position: TerminalMenuPosition;
  canPaste: boolean;
  onCopy: () => void;
  onOpenPage?: () => void;
  /** Shown only after the selected text stats as an existing remote file. */
  download?: {pending: boolean; onClick: () => void};
  onCopyTmux?: () => void;
  onPaste: () => void;
  onPasteImage?: () => void;
  onSelectAll: () => void;
  onClose: () => void;
}) {
  return createPortal(
    <PositionedMenu
      x={position.x}
      y={position.y}
      onClose={onClose}
      label="终端操作"
    >
      {onOpenPage && <MenuItem onClick={onOpenPage}>在 dssh 新标签页打开</MenuItem>}
      {download && <MenuItem disabled={download.pending} onClick={download.onClick}>下载</MenuItem>}
      <MenuItem disabled={!position.selection} onClick={onCopy}>
        复制选中文本
      </MenuItem>
      {onCopyTmux && (
        <MenuItem disabled={!canPaste} onClick={onCopyTmux}>
          复制 tmux 最近内容到本机
        </MenuItem>
      )}
      <MenuItem disabled={!canPaste} onClick={onPaste}>
        粘贴
      </MenuItem>
      {onPasteImage && (
        <MenuItem disabled={!canPaste} onClick={onPasteImage}>
          粘贴截图（上传到远程）
        </MenuItem>
      )}
      <MenuItem onClick={onSelectAll}>全选</MenuItem>
    </PositionedMenu>,
    document.body,
  );
}
