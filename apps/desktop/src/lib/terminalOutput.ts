const BEGIN = "\x1b[?2026h";
const END = "\x1b[?2026l";
const MAX_PENDING = 4 * 1024 * 1024;

/** Present pi's synchronized updates atomically, even across SSH packets.
 * Keep the original bytes (including mode sequences) for the VT parser.
 */
export function createTerminalOutput(write: (data: string) => void) {
  let pending = "";
  let synchronized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = () => {
    cancelTimer();
    const data = pending;
    pending = "";
    synchronized = false;
    if (!disposed && data) write(data);
  };

  return {
    push(chunk: string) {
      if (disposed || !chunk) return;
      pending += chunk;
      let ready = "";
      while (pending) {
        if (synchronized) {
          const end = pending.indexOf(END);
          if (end < 0) break;
          ready += pending.slice(0, end + END.length);
          pending = pending.slice(end + END.length);
          synchronized = false;
          cancelTimer();
        } else {
          const begin = pending.indexOf(BEGIN);
          if (begin >= 0) {
            ready += pending.slice(0, begin);
            pending = pending.slice(begin);
            synchronized = true;
          } else {
            // An escape sequence can be split at any byte boundary.
            let tail = Math.min(BEGIN.length - 1, pending.length);
            while (tail > 0 && !BEGIN.startsWith(pending.slice(-tail))) tail--;
            ready += pending.slice(0, pending.length - tail);
            pending = pending.slice(pending.length - tail);
            break;
          }
        }
      }
      if (ready) write(ready);
      if (pending.length >= MAX_PENDING) flush();
      // A missing terminator must not freeze the terminal or grow memory forever.
      // Do not extend the deadline when additional packets arrive.
      if (pending && timer === undefined) timer = setTimeout(flush, 1000);
      if (!pending) cancelTimer();
    },
    flush,
    dispose() {
      disposed = true;
      pending = "";
      cancelTimer();
    },
  };
}
