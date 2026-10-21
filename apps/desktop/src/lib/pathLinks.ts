import type { ILink, ILinkProvider } from "ghostty-web";
import { selectedPage, type PageTarget } from "./webPages";

interface Cell { getCodepoint(): number; getWidth?(): number }
interface Line { length: number; isWrapped?: boolean; getCell(x: number): Cell | undefined }
interface PathLinkTerminal { buffer: { active: { getLine(y: number): Line | undefined } } }

/** Keep Unicode filenames intact while mapping UTF-16 offsets back to terminal cells. */
function rowText(line: Line): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell?.getWidth?.() === 0) continue; // Wide-character continuation cell.
    const codepoint = cell?.getCodepoint() ?? 0;
    const char = codepoint >= 32 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : " ";
    for (let i = 0; i < char.length; i++) columns.push(x);
    text += char;
  }
  columns.push(line.length);
  return { text, columns };
}

/** Resolve POSIX paths on the SSH host, without interpreting shell syntax or URL schemes. */
function pathTarget(value: string, cwd: string | undefined): PageTarget | null {
  if (!value || /[:\\|&$*?\x00-\x1f\x7f]/.test(value) || value.startsWith("~") || value.startsWith("//")) return null;
  if (!value.startsWith("/")) {
    if (!value.includes("/")) return null; // A bare filename in prose or ls output is not a path link.
    if (!cwd?.startsWith("/") || cwd.startsWith("//") || /[\x00-\x1f\x7f]/.test(cwd)) return null;
    value = `${cwd}/${value}`;
  }
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return selectedPage(`/${parts.join("/")}`);
}

/** Like task links, paths are scanned lazily only for the requested buffer row. */
export function createPathLinkProvider(term: PathLinkTerminal, options: {
  cwd: (y: number) => string | undefined;
  enabled: () => boolean;
  onActivate: (target: PageTarget, event: MouseEvent) => void;
}): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = options.enabled() ? term.buffer.active.getLine(y) : undefined;
      if (!line) return callback(undefined);
      // A partial path can itself look valid. Until wrap chains are joined, do
      // not link either the leading row or any continuation of a wrapped line.
      if (line.isWrapped || term.buffer.active.getLine(y + 1)?.isWrapped) return callback(undefined);
      const links: ILink[] = [];
      const { text, columns } = rowText(line);
      // Wrappers and prose punctuation are outside the path. Keep colon suffixes
      // in a token until checked, so a scheme URL cannot become a partial path.
      const tokens = /[^\s=,()[\]{}<>"'`，。；：！？、（）【】「」『』《》“”‘’]+/g;
      for (const match of text.matchAll(tokens)) {
        const value = match[0].replace(/[.,;!?:…—]+$/, "").replace(/:\d+(?::\d+)?$/, "");
        if (!pathTarget(value, options.cwd(y))) continue;
        links.push({
          text: value,
          range: { start: { x: columns[match.index], y }, end: { x: columns[match.index + value.length] - 1, y } },
          activate: event => {
            // Recheck cached links against the connection and this row's cwd boundary.
            if (!options.enabled()) return;
            const target = pathTarget(value, options.cwd(y));
            if (target) options.onActivate(target, event);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
