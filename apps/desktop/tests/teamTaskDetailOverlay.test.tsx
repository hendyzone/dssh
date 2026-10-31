import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { fakeInvoke } from "./fixtures/taskboard";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import TaskLookup from "../src/components/TaskLookup";
import { boardSource, clearBoardCache, defaultLookupSettings, saveLookupSettings, teamLookupScope, saveTeamLock } from "../src/lib/taskLookup";

const source = boardSource({ ...defaultLookupSettings(), boardUrl: "http://board.test:8091" })!;
const teamScope = teamLookupScope("https://team.example.invalid/api/v1", "smart-table")!;
const state: { opened: string[]; calls: string[]; offline?: boolean } = { opened: [], calls: [] };

beforeEach(() => {
  localStorage.clear();
  clearBoardCache();
  state.opened = [];
  state.calls = [];
  state.offline = false;
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation(fakeInvoke(state));
  saveTeamLock(teamScope, "smart-table");
});

const openDetail = vi.fn();

it("opens the shared overlay from team lookup instead of embedding a card", async () => {
  render(<TaskLookup source={source} teamScope={teamScope} onOpenTaskDetail={openDetail}/>);
  fireEvent.change(screen.getByLabelText("任务编号"), { target: { value: "t1090" } });
  fireEvent.click(screen.getByRole("button", { name: /查询/ }));
  await waitFor(() => expect(openDetail).toHaveBeenCalledWith("smart-table", "T1090"));
  expect(screen.queryByRole("article", { name: /任务 T1090/ })).toBeNull();
  expect(document.querySelector(".task-lookup-outcome .tb-card")).toBeNull();
});

it("routes browse-list clicks through the overlay opener", async () => {
  render(<TaskLookup source={source} teamScope={teamScope} onOpenTaskDetail={openDetail}/>);
  fireEvent.click(await screen.findByText(/浏览 smart-table 的任务/));
  await screen.findByText("T1090");
  fireEvent.click(screen.getByRole("button", { name: /T1090/ }));
  await waitFor(() => expect(openDetail).toHaveBeenCalledWith("smart-table", "T1090"));
  expect(screen.queryByRole("article")).toBeNull();
});

it("mutation: inline TaskCard in panel should fail this contract", async () => {
  render(<TaskLookup source={source} teamScope={teamScope} onOpenTaskDetail={openDetail}/>);
  fireEvent.change(screen.getByLabelText("任务编号"), { target: { value: "t1090" } });
  fireEvent.click(screen.getByRole("button", { name: /查询/ }));
  await waitFor(() => expect(openDetail).toHaveBeenCalled());
  expect(screen.queryByRole("article")).toBeNull();
});
