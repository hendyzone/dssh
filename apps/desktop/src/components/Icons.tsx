/** 内联 SVG 图标（lucide 风格，stroke=currentColor，24 viewBox） */
import type { CSSProperties } from "react";

interface IconProps {
  size?: number;
  style?: CSSProperties;
}

function svg(paths: string, { size = 16, style }: IconProps, filled = false) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      <path d={paths} />
    </svg>
  );
}

export const IconPlus = (p: IconProps) => svg("M12 5v14M5 12h14", p);
export const IconSearch = (p: IconProps) =>
  svg("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", p);
export const IconSettings = (p: IconProps) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
export const IconEdit = (p: IconProps) =>
  svg("M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z", p);
export const IconClose = (p: IconProps) => svg("M18 6 6 18M6 6l12 12", p);
export const IconChevronDown = (p: IconProps) => svg("m6 9 6 6 6-6", p);
export const IconChevronRight = (p: IconProps) => svg("m9 18 6-6-6-6", p);
export const IconFolder = (p: IconProps) =>
  svg(
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
    p,
  );
export const IconForward = (p: IconProps) =>
  svg("M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4", p);
export const IconMonitor = (p: IconProps) =>
  svg(
    "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2",
    p,
  );
export const IconTerminal = (p: IconProps) => svg("M4 17l6-6-6-6M12 19h8", p);
/** 水平分屏（左右） */
export const IconSplitH = (p: IconProps) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" />
  </svg>
);
/** 垂直分屏（上下） */
export const IconSplitV = (p: IconProps) => (
  <svg
    width={p.size ?? 16}
    height={p.size ?? 16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M3 12h18" />
  </svg>
);

export const IconFile = (p: IconProps) =>
  svg(
    "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5",
    p,
  );
export const IconTasks = (p: IconProps) =>
  svg("M9 5h12M9 12h12M9 19h12M2 5l1 1 3-3M2 12l1 1 3-3M2 19l1 1 3-3", p);
export const IconChanges = (p: IconProps) =>
  svg("M8 3v12a4 4 0 0 0 4 4h5M5 6l3-3 3 3M14 16l3 3-3 3M16 3v7M12 6h8", p);
