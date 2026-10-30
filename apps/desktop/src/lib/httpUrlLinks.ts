import type { ILink, ILinkProvider } from "ghostty-web";
import { openExternalHttpUrl, sanitizeHttpUrl } from "./openExternalHttpUrl";

interface Cell { getCodepoint(): number; getWidth?(): number }
interface Line { length: number; isWrapped?: boolean; getCell(x: number): Cell | undefined }

interface HttpUrlTerminal {
  rows: number;
  buffer: { active: { length: number; getLine(y: number): Line | undefined } };
}

const HTTP_URL =
  /https?:\/\/[\w\-.~:\/?#@!$&*+,;=%]+/gi;
const TRAILING = /[.,;!?)\]」』》"'`，。；：！？、]+$/;
const MAX_WRAP = 256;

function rowText(line: Line): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell?.getWidth?.() === 0) continue;
    const codepoint = cell?.getCodepoint() ?? 0;
    const char = codepoint >= 32 && codepoint <= 0x10ffff ? String.fromCodePoint(codepoint) : " ";
    for (let i = 0; i < char.length; i++) columns.push(x);
    text += char;
  }
  columns.push(line.length);
  return { text, columns };
}

function joinedIdxToRowCol(
  joinedIdx: number,
  rowStartIdx: number[],
  baseRow: number,
): { x: number; y: number } {
  for (let i = rowStartIdx.length - 1; i >= 0; i--) {
    if (joinedIdx >= rowStartIdx[i]) return { x: joinedIdx - rowStartIdx[i], y: baseRow + i };
  }
  return { x: 0, y: baseRow };
}

export function createHttpUrlLinkProvider(
  term: HttpUrlTerminal,
  options: {
    generation: () => number;
    enabled: () => boolean;
    onHover: (href: string | null) => void;
  },
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      if (!options.enabled()) return callback(undefined);
      const buffer = term.buffer.active;
      if (!buffer.getLine(y)) return callback(undefined);

      let startRow = y;
      let walked = 0;
      while (startRow > 0 && walked < MAX_WRAP) {
        const cur = buffer.getLine(startRow);
        if (!cur?.isWrapped) break;
        startRow--;
        walked++;
      }
      let endRow = y;
      walked = 0;
      while (
        endRow + 1 < buffer.length &&
        walked < MAX_WRAP &&
        buffer.getLine(endRow + 1)?.isWrapped
      ) {
        endRow++;
        walked++;
      }

      const parts: string[] = [];
      const rowStartIdx: number[] = [];
      let joined = "";
      for (let row = startRow; row <= endRow; row++) {
        rowStartIdx.push(joined.length);
        const line = buffer.getLine(row);
        if (!line) break;
        const { text } = rowText(line);
        parts.push(text);
        joined += text;
      }

      HTTP_URL.lastIndex = 0;
      const generation = options.generation();
      const links: ILink[] = [];
      let match: RegExpExecArray | null = HTTP_URL.exec(joined);
      while (match) {
        let url = match[0].replace(TRAILING, "");
        const href = sanitizeHttpUrl(url);
        if (href && url.length > 8) {
          const startIdx = match.index;
          const endIdx = startIdx + url.length - 1;
          const startPos = joinedIdxToRowCol(startIdx, rowStartIdx, startRow);
          const endPos = joinedIdxToRowCol(endIdx, rowStartIdx, startRow);
          if (startPos.y <= y && endPos.y >= y) {
            links.push({
              text: href,
              range: { start: startPos, end: endPos },
              hover: (isHovered) => {
                if (!options.enabled()) return;
                options.onHover(isHovered ? href : null);
              },
              activate: (event) => {
                if (!options.enabled() || generation !== options.generation()) return;
                if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || event.detail > 1) return;
                void openExternalHttpUrl(href);
              },
            });
          }
        }
        match = HTTP_URL.exec(joined);
      }
      callback(links.length ? links : undefined);
    },
  };
}
