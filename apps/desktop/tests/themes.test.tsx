import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { THEMES, applyTheme, getTheme, themeCategory } from "../src/themes";
import SettingsModal from "../src/components/SettingsModal";
vi.mock("../src/platform/core", () => ({ invoke: vi.fn() }));

it("preserves legacy themes and applies separate UI and terminal palettes", () => {
  expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  expect(THEMES).toHaveLength(22);
  expect(getTheme("nord").id).toBe("nord");
  expect(getTheme("unknown").id).toBe("nord");
  const mixed = getTheme("hybrid-emerald");
  expect(themeCategory(mixed)).toBe("mixed");
  expect(mixed.ui.panel).not.toBe(mixed.term.background);
  applyTheme(mixed);
  expect(document.documentElement.style.getPropertyValue("--term-bg")).toBe(
    mixed.term.background,
  );
  expect(document.documentElement.style.getPropertyValue("--ui-panel")).toBe(
    mixed.ui.panel,
  );
  expect(getTheme("one-dark-pro").term.brightBlue).toBe("#4dc4ff");
  expect(getTheme("monokai-pro").term.red).toBe("#ff6188");
});

it("filters mixed themes, searches by name and selects a preset", () => {
  const onChange = vi.fn();
  const { container } = render(
    <SettingsModal
      settings={{ themeId: "nord", fontSize: 14, fontFamily: "monospace" }}
      onChange={onChange}
      onClose={() => {}}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "明暗混合", exact: true }),
  );
  expect(
    container.querySelectorAll(".theme-card").length ||
      document.querySelectorAll(".theme-card").length,
  ).toBe(4);
  fireEvent.click(screen.getByRole("button", { name: /Emerald · 翡翠工作台/ }));
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ themeId: "hybrid-emerald" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "全部", exact: true }));
  fireEvent.change(screen.getByLabelText("搜索主题"), {
    target: { value: "One Dark Pro" },
  });
  expect(document.querySelectorAll(".theme-card")).toHaveLength(1);
  expect(screen.getByRole("button", { name: /One Dark Pro/ })).toBeTruthy();
});
