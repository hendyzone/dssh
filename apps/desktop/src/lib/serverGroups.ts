import type { ServerEntry } from "../types";

export function groupParts(group?: string): string[] {
  return (group ?? "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface ServerGroupNode {
  name: string;
  path: string;
  children: ServerGroupNode[];
  servers: ServerEntry[];
  count: number;
}

export function buildServerTree(
  servers: ServerEntry[],
  folders: string[] = [],
  order: Record<string, string[]> = {},
): ServerGroupNode {
  const root: ServerGroupNode = {
    name: "",
    path: "",
    children: [],
    servers: [],
    count: 0,
  };
  for (const folder of folders) {
    let node = root;
    for (const name of groupParts(folder)) {
      const path = node.path ? `${node.path}/${name}` : name;
      let child = node.children.find((item) => item.name === name);
      if (!child) {
        child = { name, path, children: [], servers: [], count: 0 };
        node.children.push(child);
      }
      node = child;
    }
  }
  for (const server of servers) {
    let node = root;
    node.count++;
    for (const name of groupParts(server.group)) {
      const path = node.path ? `${node.path}/${name}` : name;
      let child = node.children.find((item) => item.name === name);
      if (!child) {
        child = { name, path, children: [], servers: [], count: 0 };
        node.children.push(child);
      }
      node = child;
      node.count++;
    }
    node.servers.push(server);
  }
  const sort = (node: ServerGroupNode) => {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    const ids = order[node.path] ?? [];
    node.servers.sort((a, b) => {
      const ai = ids.indexOf(a.id),
        bi = ids.indexOf(b.id);
      if (ai !== bi)
        return (
          (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) -
          (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
        );
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sort);
  };
  sort(root);
  return root;
}

export function groupSuggestions(servers: ServerEntry[]): string[] {
  const paths = new Set<string>();
  for (const server of servers) {
    const parts = groupParts(server.group);
    parts.forEach((_, index) => paths.add(parts.slice(0, index + 1).join("/")));
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}
