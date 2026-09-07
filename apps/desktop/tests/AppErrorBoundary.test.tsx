import { render, screen, fireEvent } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import AppErrorBoundary from "../src/components/AppErrorBoundary";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core",()=>({invoke:vi.fn().mockResolvedValue(undefined)}));

it("keeps a visible error and developer-tools entry when a child render throws",()=>{
  const consoleError=vi.spyOn(console,"error").mockImplementation(()=>{});
  function Broken(): never {throw new Error("synthetic render failure");}
  try {
    render(<AppErrorBoundary><Broken /></AppErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("synthetic render failure");
    expect(invoke).toHaveBeenCalledWith("desktop_report_error",expect.objectContaining({message:"synthetic render failure"}));
    fireEvent.click(screen.getByRole("button",{name:"打开开发者工具"}));
    expect(invoke).toHaveBeenCalledWith("desktop_devtools");
  } finally {consoleError.mockRestore();}
});
