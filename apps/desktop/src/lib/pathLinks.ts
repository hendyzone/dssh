import type { ILink, ILinkProvider } from "ghostty-web";
import { selectedPage, type PageTarget } from "./webPages";

interface Cell { getCodepoint(): number; getWidth?(): number }
interface Line { length: number; isWrapped?: boolean; getCell(x: number): Cell | undefined }
interface PathLinkTerminal { rows: number; buffer: { active: { length: number; getLine(y: number): Line | undefined } } }

function fillsLastCell(line: Line | undefined): boolean {
  if (!line?.length) return false;
  const last = line.getCell(line.length - 1);
  return !!last?.getCodepoint() || last?.getWidth?.() === 0;
}

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

/** Accept absolute POSIX paths without interpreting shell syntax or URL schemes. */
function pathTarget(value: string): PageTarget | null {
  if (!value.startsWith("/") || value.startsWith("//") || /[:\\|&$*?\x00-\x1f\x7f]/.test(value)) return null;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return selectedPage(`/${parts.join("/")}`);
}

/** Like task links, paths are scanned lazily only for the requested buffer row. */
export function createPathLinkProvider(term: PathLinkTerminal, options: {
  generation: () => number;
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
      const history = y < Math.max(0, term.buffer.active.length - term.rows);
      const generation = options.generation();
      const links: ILink[] = [];
      const { text, columns } = rowText(line);
      // Wrappers and prose punctuation are outside the path. Keep colon suffixes
      // in a token until checked, so a scheme URL cannot become a partial path.
      const tokens = /[^\s=,()[\]{}<>"'`，。；：！？、（）【】「」『』《》“”‘’]+/g;
      for (const match of text.matchAll(tokens)) {
        // Scrollback has no wrap flags. A token at a full row's edge may be
        // just one fragment of a longer path, including an absolute-looking tail.
        if (history && (columns[match.index + match[0].length] === line.length ||
          (columns[match.index] === 0 && fillsLastCell(term.buffer.active.getLine(y - 1))))) continue;
        const value = match[0].replace(/[.,;!?:…—]+$/, "").replace(/:\d+(?::\d+)?$/, "");
        const target = pathTarget(value);
        if (!target) continue;
        links.push({
          text: value,
          range: { start: { x: columns[match.index], y }, end: { x: columns[match.index + value.length] - 1, y } },
          activate: event => {
            // Reflow and reconnects invalidate links captured by the old terminal state.
            if (!options.enabled() || generation !== options.generation()) return;
            options.onActivate(target, event);
          },
        });
      }
      callback(links.length ? links : undefined);
    },
  };
}
