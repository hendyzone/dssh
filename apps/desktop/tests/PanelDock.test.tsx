import { useEffect } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import PanelDock from "../src/components/PanelDock";

it.each(["left", "right"])(
  "resizes the %s dock in the correct direction and remembers its width",
  (side) => {
    localStorage.setItem("dssh.panel-side.sftp", side);
    const view = render(
      <PanelDock kind="sftp">
        <aside>files</aside>
      </PanelDock>,
    );
    const separator = screen.getByRole("separator");
    separator.setPointerCapture = vi.fn();
    const pointer = (type: string, x: number) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        button: 0,
      });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(separator, event);
    };
    pointer("pointerdown", 600);
    pointer("pointermove", side === "right" ? 500 : 700);
    pointer("pointerup", side === "right" ? 500 : 700);
    expect(screen.getByLabelText("sftp 停靠面板").style.width).toBe("490px");
    expect(localStorage.getItem("dssh.panel-width.sftp")).toBe("490");
    view.unmount();
    render(
      <PanelDock kind="sftp">
        <aside>files</aside>
      </PanelDock>,
    );
    expect(screen.getByLabelText("sftp 停靠面板").style.width).toBe("490px");
    fireEvent.doubleClick(screen.getByRole("separator"));
    expect(screen.getByLabelText("sftp 停靠面板").style.width).toBe("390px");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "Home" });
    expect(screen.getByLabelText("sftp 停靠面板").style.width).toBe("260px");
  },
);

it("docks after a pointer drop and cancels a drag on Escape", () => {
  render(
    <div>
      <PanelDock kind="tmux">
        <aside>
          <header data-panel-drag-handle>drag title</header>
        </aside>
      </PanelDock>
    </div>,
  );
  const dock = screen.getByLabelText("tmux 停靠面板");
  dock.setPointerCapture = vi.fn();
  vi.spyOn(dock.parentElement!, "getBoundingClientRect").mockReturnValue({
    left: 0,
    right: 1000,
    top: 0,
    bottom: 600,
    width: 1000,
    height: 600,
  } as DOMRect);
  const pointer = (element: Element, type: string, x: number, y = 50) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
    });
    Object.defineProperty(event, "pointerId", { value: 1 });
    fireEvent(element, event);
  };
  pointer(screen.getByText("drag title"), "pointerdown", 900);
  pointer(dock, "pointermove", 100);
  expect(screen.getByText("松开固定到左侧")).toBeTruthy();
  pointer(dock, "pointerup", 100);
  expect(dock.className).toContain("panel-dock-left");
  pointer(screen.getByText("drag title"), "pointerdown", 100);
  pointer(dock, "pointermove", 900);
  fireEvent.keyDown(window, { key: "Escape" });
  pointer(dock, "pointerup", 900);
  expect(dock.className).toContain("panel-dock-left");
  expect(screen.queryByText("松开固定到右侧")).toBeNull();
});

it("remembers position per tool without remounting its live content", () => {
  const mount = vi.fn();
  const unmount = vi.fn();
  function Content() {
    useEffect(() => {
      mount();
      return unmount;
    }, []);
    return (
      <aside>
        <header data-panel-drag-handle tabIndex={0}>
          live content
        </header>
      </aside>
    );
  }
  const view = render(
    <PanelDock kind="tmux">
      <Content />
    </PanelDock>,
  );
  fireEvent.keyDown(screen.getByText("live content"), {
    key: "ArrowLeft",
    altKey: true,
  });
  expect(screen.getByLabelText("tmux 停靠面板").className).toContain(
    "panel-dock-left",
  );
  expect(mount).toHaveBeenCalledTimes(1);
  expect(unmount).not.toHaveBeenCalled();
  view.unmount();
  const next = render(
    <PanelDock kind="tmux">
      <span />
    </PanelDock>,
  );
  expect(screen.getByLabelText("tmux 停靠面板").className).toContain(
    "panel-dock-left",
  );
  next.unmount();
  render(
    <PanelDock kind="sftp">
      <span />
    </PanelDock>,
  );
  expect(screen.getByLabelText("sftp 停靠面板").className).toContain(
    "panel-dock-right",
  );
});
