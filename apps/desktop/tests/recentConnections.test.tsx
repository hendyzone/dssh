import { expect, it } from "vitest";
import {
  loadRecentConnections,
  rememberConnection,
  sortByRecentConnections,
} from "../src/lib/recentConnections";

it("puts recent connections first without changing saved order or adding deleted entries", () => {
  const connections = ["a", "b", "c", "d"].map((id) => ({ id }));
  expect(
    sortByRecentConnections(connections, ["deleted", "c", "a"]).map(
      (s) => s.id,
    ),
  ).toEqual(["c", "a", "b", "d"]);
  expect(connections.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
});

it("keeps ten distinct connections, moves reopened entries first and restores history", () => {
  let ids: string[] = [];
  for (let i = 0; i < 12; i++) ids = rememberConnection(ids, String(i));
  expect(ids).toHaveLength(10);
  expect(ids[0]).toBe("11");
  expect(ids).not.toContain("1");
  ids = rememberConnection(ids, "5");
  expect(ids[0]).toBe("5");
  expect(ids.filter((id) => id === "5")).toHaveLength(1);
  expect(loadRecentConnections()).toEqual(ids);
});
it("ignores damaged history", () => {
  localStorage.setItem("dssh.recent-connections", "invalid");
  expect(loadRecentConnections()).toEqual([]);
});
