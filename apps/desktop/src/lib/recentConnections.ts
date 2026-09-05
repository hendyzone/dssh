const KEY = "dssh.recent-connections";
export function sortByRecentConnections<T extends { id: string }>(
  connections: T[],
  recentIds: string[],
): T[] {
  const order = new Map(recentIds.map((id, index) => [id, index]));
  return [...connections].sort(
    (a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity),
  );
}
export function loadRecentConnections(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter((id): id is string => typeof id === "string"),
          ),
        ].slice(0, 10)
      : [];
  } catch {
    return [];
  }
}
export function rememberConnection(ids: string[], id: string): string[] {
  const next = [id, ...ids.filter((previous) => previous !== id)].slice(0, 10);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* History remains available in memory. */
  }
  return next;
}
