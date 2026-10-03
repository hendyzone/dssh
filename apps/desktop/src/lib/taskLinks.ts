import type { ILink, ILinkProvider } from "ghostty-web";
import { findTaskCodes, type IndexTask } from "./taskLookup";

interface Cell { getCodepoint(): number }
interface Line { length: number; getCell(x: number): Cell | undefined }
export interface TaskLinkTerminal { buffer: { active: { getLine(y: number): Line | undefined } } }

/** One string character per cell, so string offsets are terminal columns (wide chars keep their spacer). */
export function lineText(line: Line): string {
  let text = "";
  for (let x = 0; x < line.length; x++) {
    const codepoint = line.getCell(x)?.getCodepoint() ?? 0;
    // Astral code points would take two UTF-16 units and shift columns; they never belong to a code.
    text += codepoint >= 32 && codepoint <= 0xffff ? String.fromCharCode(codepoint) : " ";
  }
  return text;
}

/**
 * ghostty-web asks for links lazily, one buffer row at a time when the pointer rests on it,
 * and caches rows until the next write. So output volume never triggers matching; only the
 * hovered row is scanned, against a Map of codes that really exist on the project's board.
 */
export function createTaskLinkProvider(term: TaskLinkTerminal, options: {
  index: () => Map<string, IndexTask> | undefined;
  onHover: (task: IndexTask | null) => void;
  onActivate: (task: IndexTask, event: MouseEvent) => void;
}): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const index = options.index();
      const line = index?.size ? term.buffer.active.getLine(y) : undefined;
      if (!index || !line) return callback(undefined);
      const links: ILink[] = findTaskCodes(lineText(line), code => index.has(code)).map(match => {
        const task = index.get(match.code)!;
        return {
          text: match.code,
          range: { start: { x: match.start, y }, end: { x: match.end - 1, y } },
          activate: event => options.onActivate(task, event),
          hover: hovered => options.onHover(hovered ? task : null),
        };
      });
      callback(links.length ? links : undefined);
    },
  };
}
