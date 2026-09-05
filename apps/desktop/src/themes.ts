/** 主题预设：ui 驱动界面 CSS 变量，term 传给 ghostty-web */
export interface ThemePreset {
  id: string;
  name: string;
  description?: string;
  ui: {
    bg: string;
    panel: string;
    panelAlt: string;
    fg: string;
    muted: string;
    accent: string;
    border: string;
    danger: string;
  };
  term: {
    background: string;
    foreground: string;
    cursor: string;
    cursorAccent: string;
    selectionBackground: string;
  };
}

export const THEMES: ThemePreset[] = [
  {
    id: "nord",
    name: "Nord · 冷灰蓝",
    description: "低饱和蓝灰，清晰沉稳",
    ui: {
      bg: "#2e3440",
      panel: "#2e3440",
      panelAlt: "#3b4252",
      fg: "#eceff4",
      muted: "#a7b1c2",
      accent: "#88c0d0",
      border: "#4c566a",
      danger: "#bf616a",
    },
    term: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#88c0d0",
      cursorAccent: "#2e3440",
      selectionBackground: "#434c5e",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Latte · 清爽浅色",
    description: "浅灰底色，蓝色重点，适合白天",
    ui: {
      bg: "#eff1f5",
      panel: "#eff1f5",
      panelAlt: "#e6e9ef",
      fg: "#4c4f69",
      muted: "#6c6f85",
      accent: "#1e66f5",
      border: "#ccd0da",
      danger: "#d20f39",
    },
    term: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#1e66f5",
      cursorAccent: "#eff1f5",
      selectionBackground: "#ccd0da",
    },
  },
  {
    id: "graphite",
    name: "Graphite · 石墨黑",
    description: "中性深灰，少量蓝色点缀",
    ui: {
      bg: "#17191d",
      panel: "#1c1f24",
      panelAlt: "#22262d",
      fg: "#e6eaf0",
      muted: "#9ba6b7",
      accent: "#80b4ff",
      border: "#363e4b",
      danger: "#ff8792",
    },
    term: {
      background: "#17191d",
      foreground: "#e6eaf0",
      cursor: "#80b4ff",
      cursorAccent: "#17191d",
      selectionBackground: "#34465f",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night · 蓝紫夜色",
    ui: {
      bg: "#1a1b26",
      panel: "#16161e",
      panelAlt: "#1f2335",
      fg: "#a9b1d6",
      muted: "#565f89",
      accent: "#7aa2f7",
      border: "#292e42",
      danger: "#f7768e",
    },
    term: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin Mocha",
    description: "柔和蓝紫，暖色文字",
    ui: {
      bg: "#1e1e2e",
      panel: "#181825",
      panelAlt: "#313244",
      fg: "#cdd6f4",
      muted: "#6c7086",
      accent: "#89b4fa",
      border: "#45475a",
      danger: "#f38ba8",
    },
    term: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#45475a",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox Dark",
    ui: {
      bg: "#282828",
      panel: "#1d2021",
      panelAlt: "#3c3836",
      fg: "#ebdbb2",
      muted: "#928374",
      accent: "#83a598",
      border: "#504945",
      danger: "#fb4934",
    },
    term: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
    },
  },
  {
    id: "one-light",
    name: "One Light（浅色）",
    ui: {
      bg: "#fafafa",
      panel: "#f0f0f0",
      panelAlt: "#e5e5e6",
      fg: "#383a42",
      muted: "#a0a1a7",
      accent: "#4078f2",
      border: "#d3d4d6",
      danger: "#e45649",
    },
    term: {
      background: "#fafafa",
      foreground: "#383a42",
      cursor: "#383a42",
      cursorAccent: "#fafafa",
      selectionBackground: "#d3d4d6",
    },
  },
];

export function getTheme(id: string): ThemePreset {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** 把主题应用到 :root CSS 变量 */
export function applyTheme(theme: ThemePreset): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.ui)) {
    root.style.setProperty(`--ui-${key}`, value);
  }
}
