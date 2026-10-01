import type { ServerEntry } from "../types";

/** A local target is never saved in the SSH server/credential store. */
export const LOCAL_SHELL: ServerEntry = {
  id: "dssh:local", kind: "local", name: "本地终端",
  host: "localhost", port: 0, username: "", authMethod: "password",
};
export const isLocalShell = (server: ServerEntry) => server.kind === "local";

export function quoteLocalPath(path: string, windows = /Win/i.test(navigator.platform)): string {
  return "'" + path.replace(/'/g, windows ? "''" : "'\"'\"'") + "'";
}
