/** OSC 7501 Program Status Protocol, revision 0.4 (2026-10-10). */
export type ProgramStatusState = "idle" | "working" | "done" | "blocked" | "error";
export type ProgramStatusKind = "permission" | "question" | "auth";

export interface ProgramStatusRecord {
  /** The empty string identifies the terminal's root record. */
  id: string;
  state: ProgramStatusState;
  app?: string;
  title?: string;
  msg?: string;
  kind?: ProgramStatusKind;
  progress?: number;
  updatedAt: number;
}

export type ProgramStatusEvent =
  | { type: "report"; record: ProgramStatusRecord; records: ProgramStatusRecord[] }
  | { type: "clear"; id: string; records: ProgramStatusRecord[] }
  | { type: "prompt" | "reset" | "exit"; records: ProgramStatusRecord[] }
  | { type: "query"; reply: string }
  | { type: "legacy-osc"; body: string }
  | { type: "text"; text: string };

export const PROGRAM_STATUS_REPLY = "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\";
const MAX_SEQUENCE_BYTES = 4096;
const MAX_RECORDS = 256;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const states = new Set<string>(["idle", "working", "done", "blocked", "error"]);
const kinds = new Set<string>(["permission", "question", "auth"]);
const segmentPattern = /^[A-Za-z0-9_.+-]{1,32}$/;
const valuePattern = /^[A-Za-z0-9_.,+/=\-]*$/;

type ParsedReport = Omit<ProgramStatusRecord, "updatedAt" | "state"> & {
  state: ProgramStatusState | "clear";
};

/** Base64 is validated before atob: browsers otherwise accept embedded whitespace. */
function decodeText(value: string, maxBytes: number): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const unpadded = value.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  if (value.includes("=") && (value.length % 4 !== 0 || value.length - unpadded.length !== (4 - unpadded.length % 4) % 4)) return null;
  try {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
    if (bytes.length > maxBytes) return null;
    const text = decoder.decode(bytes);
    return /[\u0000-\u001f\u007f-\u009f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

/** Validate every occurrence, including overwritten keys, before applying anything. */
function parseReport(body: string): ParsedReport | null {
  const pairs = new Map<string, string>();
  const decodedText = new Map<string, string>();
  for (const pair of body.split(":")) {
    const separator = pair.indexOf("=");
    const key = (separator === -1 ? pair : pair.slice(0, separator)).trim();
    const value = separator === -1 ? "" : pair.slice(separator + 1).trim();
    if (encoder.encode(key).length > 16) return null;
    // Limits apply even if a later pair would replace this one.
    if (key === "msg" && encoder.encode(value).length > 2732) return null;
    if (key === "title" && encoder.encode(value).length > 256) return null;
    if (key === "app" && encoder.encode(value).length > 32) return null;
    if (key === "id") {
      const segments = value.split("/");
      if (encoder.encode(value).length > 128 || segments.length > 8 || segments.some((segment) => encoder.encode(segment).length > 32)) return null;
      // An explicit but malformed address must never fall back to the root.
      if (separator !== -1 && !valuePattern.test(value)) return null;
    }
    if (separator === -1 || !/^[a-z]+$/.test(key) || !valuePattern.test(value)) continue;
    if (key === "msg" || key === "title") {
      const text = decodeText(value, key === "msg" ? 2048 : 192);
      if (text === null) return null;
      decodedText.set(key, text);
    }
    // Unknown keys are intentionally ignored, after checking the key limit.
    if (["state", "id", "kind", "progress", "app", "title", "msg"].includes(key)) pairs.set(key, value);
  }
  const state = pairs.get("state");
  if (state !== "clear" && !states.has(state ?? "")) return null;
  const id = pairs.get("id") ?? "";
  if (pairs.has("id") && !id.split("/").every((segment) => segmentPattern.test(segment))) return null;
  const report: ParsedReport = { id, state: state as ParsedReport["state"] };
  const app = pairs.get("app");
  if (app !== undefined && segmentPattern.test(app)) report.app = app;
  if (decodedText.has("msg")) report.msg = decodedText.get("msg");
  if (decodedText.has("title")) report.title = decodedText.get("title");
  const kind = pairs.get("kind");
  if (state === "blocked" && kinds.has(kind ?? "")) report.kind = kind as ProgramStatusKind;
  const progress = pairs.get("progress");
  if ((state === "working" || state === "blocked") && progress !== undefined && /^\d+$/.test(progress)) {
    const number = Number(progress);
    if (number >= 0 && number <= 100) report.progress = number;
  }
  return report;
}

type ScannerState = "ground" | "escape" | "csi" | "osc" | "osc-escape" | "string" | "string-escape";

/**
 * One tracker per PTY. Its bounded VT scanner preserves stream order and never
 * interprets sequences nested in an unrelated control string as status reports.
 * Reads do not refresh record lifetime or the least-recently-updated eviction order.
 */
export class ProgramStatusTracker {
  private records = new Map<string, ProgramStatusRecord>();
  private scanner: ScannerState = "ground";
  private escapeIntermediate = false;
  private oscBody = "";
  private oscBytes = 0;
  private oscOverflow = false;

  /** Snapshots expose inherited app identities without modifying stored reports. */
  getRecords(): ProgramStatusRecord[] {
    return Array.from(this.records.values(), (record) => {
      const result = { ...record };
      let ancestor = record.id;
      while (result.app === undefined && ancestor !== "") {
        const slash = ancestor.lastIndexOf("/");
        ancestor = slash === -1 ? "" : ancestor.slice(0, slash);
        const app = this.records.get(ancestor)?.app;
        if (app !== undefined) result.app = app;
      }
      return result;
    });
  }

  /** Process exit is an event, not a timer; completed results remain available. */
  processExit(): { type: "exit"; records: ProgramStatusRecord[] } {
    this.resetScanner();
    this.dropActive();
    return { type: "exit", records: this.getRecords() };
  }

  /** RIS clears records on both screens and abandons any partial sequence. */
  reset(): { type: "reset"; records: ProgramStatusRecord[] } {
    this.records.clear();
    this.resetScanner();
    return { type: "reset", records: [] };
  }

  feed(chunk: string, now = Date.now()): ProgramStatusEvent[] {
    const events: ProgramStatusEvent[] = [];
    let text = "";
    const flushText = () => {
      if (text) events.push({ type: "text", text });
      text = "";
    };
    for (const character of chunk) {
      const code = character.codePointAt(0)!;
      if (character === "\x18" || character === "\x1a") {
        flushText();
        this.resetScanner();
        continue;
      }
      if (this.scanner === "osc" || this.scanner === "osc-escape") {
        if (character === "\x07" || character === "\x9c" || (this.scanner === "osc-escape" && character === "\\")) {
          if (this.scanner === "osc-escape" && character !== "\\") this.appendOsc("\x1b", false);
          // The pending ESC was already counted; BEL/C1 ST use one byte here.
          const terminatorBytes = character === "\x9c" ? 2 : 1;
          if (!this.oscOverflow && this.oscBytes + terminatorBytes <= MAX_SEQUENCE_BYTES) this.handleOsc(events, now);
          this.resetScanner();
        } else {
          if (this.scanner === "osc-escape") this.appendOsc("\x1b", false);
          if (character === "\x1b") {
            this.oscBytes = Math.min(MAX_SEQUENCE_BYTES + 1, this.oscBytes + 1);
            if (this.oscBytes > MAX_SEQUENCE_BYTES) this.oscOverflow = true;
            this.scanner = "osc-escape";
          } else {
            this.appendOsc(character);
            this.scanner = "osc";
          }
        }
        continue;
      }
      if (this.scanner === "string" || this.scanner === "string-escape") {
        if (character === "\x9c" || (this.scanner === "string-escape" && character === "\\")) this.scanner = "ground";
        else this.scanner = character === "\x1b" ? "string-escape" : "string";
        continue;
      }
      if (character === "\x1b") {
        flushText();
        this.scanner = "escape";
        this.escapeIntermediate = false;
        continue;
      }
      if (this.scanner === "escape") {
        if (!this.escapeIntermediate && character === "]") this.startOsc(2);
        else if (!this.escapeIntermediate && character === "[") this.scanner = "csi";
        else if (!this.escapeIntermediate && ["P", "X", "^", "_"].includes(character)) this.scanner = "string";
        else if (!this.escapeIntermediate && character === "c") events.push(this.reset());
        else if (code >= 0x20 && code <= 0x2f) this.escapeIntermediate = true;
        else if (code >= 0x30) this.scanner = "ground";
        continue;
      }
      if (this.scanner === "csi") {
        if (code >= 0x40 && code <= 0x7e) this.scanner = "ground";
        continue;
      }
      if (character === "\x9d") {
        flushText();
        this.startOsc(2);
      } else if (character === "\x9b") {
        flushText();
        this.scanner = "csi";
      } else if (["\x90", "\x98", "\x9e", "\x9f"].includes(character)) {
        flushText();
        this.scanner = "string";
      } else if ((code >= 0x20 && !(code >= 0x7f && code <= 0x9f)) || character === "\n" || character === "\r" || character === "\t") {
        text += character;
      }
    }
    flushText();
    return events;
  }

  private startOsc(prefixBytes: number): void {
    this.scanner = "osc";
    this.oscBody = "";
    this.oscBytes = prefixBytes;
    this.oscOverflow = false;
  }

  private appendOsc(character: string, countBytes = true): void {
    if (this.oscOverflow) return;
    if (countBytes) this.oscBytes = Math.min(MAX_SEQUENCE_BYTES + 1, this.oscBytes + encoder.encode(character).length);
    if (this.oscBytes > MAX_SEQUENCE_BYTES) this.oscOverflow = true;
    if (!this.oscOverflow) this.oscBody += character;
  }

  private resetScanner(): void {
    this.scanner = "ground";
    this.escapeIntermediate = false;
    this.oscBody = "";
    this.oscBytes = 0;
    this.oscOverflow = false;
  }

  private dropActive(): void {
    for (const [id, record] of this.records) {
      if (record.state === "working" || record.state === "blocked") this.records.delete(id);
    }
  }

  private handleOsc(events: ProgramStatusEvent[], now: number): void {
    if (this.oscBody === "133;A" || this.oscBody.startsWith("133;A;")) {
      this.dropActive();
      events.push({ type: "prompt", records: this.getRecords() });
      return;
    }
    if (this.oscBody.startsWith("9;") || this.oscBody.startsWith("777;")) {
      events.push({ type: "legacy-osc", body: this.oscBody });
      return;
    }
    if (!this.oscBody.startsWith("7501;")) return;
    const body = this.oscBody.slice(5);
    if (body.trim() === "?") {
      events.push({ type: "query", reply: PROGRAM_STATUS_REPLY });
      return;
    }
    const report = parseReport(body);
    if (!report) return;
    if (report.state === "clear") {
      for (const id of this.records.keys()) {
        if (report.id === "" || id === report.id || id.startsWith(`${report.id}/`)) this.records.delete(id);
      }
      events.push({ type: "clear", id: report.id, records: this.getRecords() });
      return;
    }
    const record: ProgramStatusRecord = { ...report, state: report.state, updatedAt: now };
    this.records.delete(record.id);
    if (this.records.size >= MAX_RECORDS) this.records.delete(this.records.keys().next().value!);
    this.records.set(record.id, record);
    events.push({ type: "report", record: { ...record }, records: this.getRecords() });
  }
}
