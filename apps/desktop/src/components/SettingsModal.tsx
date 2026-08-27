import { THEMES } from "../themes";
import type { AppSettings } from "../types";

interface Props {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onClose: () => void;
}

/** 设置面板：主题 / 字号 / 字体 */
export default function SettingsModal({ settings, onChange, onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>
        <label>主题</label>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className={`theme-card ${settings.themeId === t.id ? "active" : ""}`}
              onClick={() => onChange({ ...settings, themeId: t.id })}
            >
              <span className="theme-swatches">
                <i style={{ background: t.term.background }} />
                <i style={{ background: t.term.foreground }} />
                <i style={{ background: t.ui.accent }} />
              </span>
              {t.name}
            </button>
          ))}
        </div>
        <label>
          字号：{settings.fontSize}px
          <input
            type="range"
            min="10"
            max="24"
            value={settings.fontSize}
            onChange={(e) =>
              onChange({ ...settings, fontSize: Number(e.target.value) })
            }
          />
        </label>
        <label>
          字体
          <input
            value={settings.fontFamily}
            onChange={(e) =>
              onChange({ ...settings, fontFamily: e.target.value })
            }
            placeholder="JetBrains Mono, monospace"
          />
        </label>
        <div className="form-actions">
          <button type="button" className="btn-primary" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
