import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ConnectionTabStrip } from "../src/components/ConnectionGroups";
import type { TabInfo } from "../src/types";

const tabs: TabInfo[] = Array.from({ length: 8 }, (_, index) => ({
  id: `tab-${index}`,
  activePane: 0,
  panes: [
    {
      id: `pane-${index}`,
      server: {
        id: `srv-${index}`,
        name: `Host ${index}`,
        host: "example.com",
        port: 22,
        username: "root",
        authMethod: "password",
      },
    },
  ],
}));

it("keeps tab toolbar outside the horizontal scrollport", () => {
  const view = render(
    <ConnectionTabStrip
      tabs={tabs}
      groups={[]}
      activeTabId="tab-0"
      renderTab={(tab) => (
        <div key={tab.id} role="tab" className="tab" aria-selected={tab.id === "tab-0"}>
          {tab.panes[0].server.name}
        </div>
      )}
      onToggle={vi.fn()}
      onEdit={vi.fn()}
      onCreate={vi.fn()}
      onNewTab={vi.fn()}
      onMove={vi.fn()}
    />,
  );
  const scroll = view.container.querySelector("[data-tab-scroll]");
  const toolbar = view.container.querySelector("[data-tab-toolbar]");
  expect(scroll).toBeTruthy();
  expect(toolbar).toBeTruthy();
  expect(scroll!.contains(toolbar)).toBe(false);
  expect(toolbar!.querySelector(".tab-new")).toBeTruthy();
  expect(scroll!.querySelector(".tab-new")).toBeNull();
});
