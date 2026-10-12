import { describe, expect, it } from "vitest";
import { PROGRAM_STATUS_REPLY, ProgramStatusTracker } from "../src/lib/programStatus";

const osc = (body: string, terminator = "\x1b\\") => `\x1b]7501;${body}${terminator}`;
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const report = (body: string) => {
  const tracker = new ProgramStatusTracker();
  tracker.feed(osc(body), 123);
  return tracker.getRecords();
};

describe("OSC 7501 revision 0.4 reports", () => {
  it("accepts every state without a probe and keeps optional fields only where meaningful", () => {
    for (const state of ["idle", "working", "done", "blocked", "error"]) {
      expect(report(`state=${state}:kind=auth:progress=42:app=cargo`)).toEqual([{
        id: "", state, app: "cargo", updatedAt: 123,
        ...(state === "blocked" ? { kind: "auth" } : {}),
        ...(["working", "blocked"].includes(state) ? { progress: 42 } : {}),
      }]);
    }
  });

  it("ignores unknown keys and malformed pairs, trims pairs and uses the last value", () => {
    expect(report(" state = working :Future=ignored:future=extension:broken:=bad:msg=hello!:state=blocked:kind=permission:kind=question:progress=1:progress=100 "))
      .toEqual([{ id: "", state: "blocked", kind: "question", progress: 100, updatedAt: 123 }]);
    expect(report("state=done:state=wat")).toEqual([]);
    expect(report("app=cargo")).toEqual([]);
    expect(report("state=idle:state=bad!")).toMatchObject([{ state: "idle" }]);
  });

  it("decodes padded or unpadded standard base64 UTF-8 without treating text as machine fields", () => {
    const msg = "需批准 <script>state=error</script>";
    expect(report(`state=working:msg=${base64(msg).replace(/=+$/, "")}:title=${base64("构建")}`))
      .toEqual([{ id: "", state: "working", msg, title: "构建", updatedAt: 123 }]);
    expect(report("state=idle:msg=:title=")).toMatchObject([{ msg: "", title: "" }]);
    expect(report(`state=idle:msg=${base64("\ufefflabel")}`)).toMatchObject([{ msg: "\ufefflabel" }]);
  });

  it.each(["A", "_w==", "AA=", "AA===", "====", "YQ==YQ==", "/w==", "wK8="])("atomically rejects invalid base64 or UTF-8: %s", (value) => {
    const tracker = new ProgramStatusTracker();
    tracker.feed(osc("state=working:app=old"));
    tracker.feed(osc(`state=done:app=new:msg=${value}:msg=${base64("later valid")}`));
    expect(tracker.getRecords()).toMatchObject([{ state: "working", app: "old" }]);
  });

  it("rejects each forbidden control character, including overwritten values and clear reports", () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), ...Array.from({ length: 33 }, (_, i) => 127 + i)]) {
      for (const key of ["msg", "title"]) {
        expect(report(`state=done:${key}=${base64(`before${String.fromCharCode(code)}after`)}:${key}=${base64("valid")}`)).toEqual([]);
      }
    }
    const tracker = new ProgramStatusTracker();
    tracker.feed(osc("state=done"));
    tracker.feed(osc(`state=clear:msg=${base64("\n")}`));
    expect(tracker.getRecords()).toHaveLength(1);
  });

  it("rejects all per-pair limits before applying or overwriting values", () => {
    const oversized = [
      `${"k".repeat(17)}=unknown`,
      `msg=${"A".repeat(2733)}`,
      `msg=${base64("a".repeat(2049))}`,
      `title=${"A".repeat(257)}`,
      `app=${"a".repeat(33)}`,
      `id=${"a".repeat(33)}`,
      `id=${Array(9).fill("x").join("/")}`,
      `id=${Array(4).fill("a".repeat(32)).join("/")}`,
    ];
    for (const pair of oversized) expect(report(`state=done:${pair}:msg=:title=:app=valid:id=valid`)).toEqual([]);
    expect(report(`state=done:msg=${base64("a".repeat(2048))}:title=${base64("b".repeat(192))}`)).toHaveLength(1);
  });

  it("rejects invalid ids without falling back to the root and supports the depth/length boundaries", () => {
    for (const id of ["", "/", "a/", "/a", "a//b", "a,b", "a=b", "a!", "a b", "a;state=error"]) expect(report(`state=done:id=${id}`)).toEqual([]);
    expect(report(`state=done:id=${Array(8).fill("x").join("/")}`)).toHaveLength(1);
    expect(report(`state=done:id=${["a".repeat(32), "b".repeat(32), "c".repeat(32), "d".repeat(29)].join("/")}`)).toHaveLength(1);
  });

  it("treats unknown kinds, invalid app syntax and invalid progress as absent", () => {
    for (const progress of ["", "-1", "101", "2.5", "1e2", "+1"]) {
      expect(report(`state=blocked:kind=unknown:app=a/b:progress=${progress}`))
        .toEqual([{ id: "", state: "blocked", updatedAt: 123 }]);
    }
    expect(report("state=working:progress=000")).toMatchObject([{ progress: 0 }]);
    expect(report("state=working:progress=100")).toMatchObject([{ progress: 100 }]);
  });
});

describe("terminal record lifecycle", () => {
  it("fully replaces records and dynamically inherits app from the closest existing ancestor", () => {
    const tracker = new ProgramStatusTracker();
    tracker.feed(osc("state=working:app=root") + osc("state=working:id=a:app=child") + osc("state=blocked:id=a/b/c:kind=auth"));
    expect(tracker.getRecords().find(({ id }) => id === "a/b/c")?.app).toBe("child");
    tracker.feed(osc("state=idle:id=a"), 456);
    expect(tracker.getRecords().find(({ id }) => id === "a")).toEqual({ id: "a", state: "idle", app: "root", updatedAt: 456 });
    expect(tracker.getRecords().find(({ id }) => id === "a/b/c")?.app).toBe("root");
    tracker.feed(osc("state=done"));
    expect(tracker.getRecords().find(({ id }) => id === "a/b/c")?.app).toBeUndefined();
  });

  it("clears exact descendants even without a parent record, but not similarly named siblings", () => {
    const tracker = new ProgramStatusTracker();
    tracker.feed(["a/b", "a/b/c", "ab", "a2/b"].map((id) => osc(`state=done:id=${id}`)).join(""));
    expect(tracker.feed(osc("state=clear:id=a"))[0]).toMatchObject({ type: "clear", id: "a" });
    expect(tracker.getRecords().map(({ id }) => id)).toEqual(["ab", "a2/b"]);
    tracker.feed(osc("state=clear"));
    expect(tracker.getRecords()).toEqual([]);
  });

  it("does not expire records and preserves idle/done/error over prompt and process exit", () => {
    const tracker = new ProgramStatusTracker();
    const populate = () => tracker.feed(["idle", "working", "blocked", "done", "error"].map((state) => osc(`state=${state}:id=${state}`)).join(""), 1);
    populate();
    tracker.feed("later output", Number.MAX_SAFE_INTEGER);
    expect(tracker.getRecords()).toHaveLength(5);
    expect(tracker.feed("\x1b]133;A;aid=example\x07")[0]).toMatchObject({ type: "prompt" });
    expect(tracker.getRecords().map(({ state }) => state)).toEqual(["idle", "done", "error"]);
    populate();
    tracker.feed("\x1b]7501;state=working");
    expect(tracker.processExit()).toMatchObject({ type: "exit" });
    expect(tracker.getRecords().map(({ state }) => state)).toEqual(["idle", "done", "error"]);
    tracker.feed("\x07");
    expect(tracker.getRecords()).toHaveLength(3);
  });

  it("preserves records over alternate screen and soft reset, and clears them on RIS", () => {
    const tracker = new ProgramStatusTracker();
    tracker.feed(osc("state=done"));
    tracker.feed("\x1b[?1049h\x1b[?1049l\x1b[!p");
    expect(tracker.getRecords()).toHaveLength(1);
    expect(tracker.feed("\x1bc")).toEqual([{ type: "reset", records: [] }]);
    expect(tracker.getRecords()).toHaveLength(0);
  });

  it("evicts the least recently updated record at 256, without refreshing on reads", () => {
    const tracker = new ProgramStatusTracker();
    for (let index = 0; index < 256; index++) tracker.feed(osc(`state=idle:id=n${index}`), 1);
    tracker.feed(osc("state=working:id=n0"), 1);
    tracker.getRecords();
    tracker.feed(osc("state=done:id=new"), 1);
    const ids = tracker.getRecords().map(({ id }) => id);
    expect(ids).toHaveLength(256);
    expect(ids).toContain("n0");
    expect(ids).not.toContain("n1");
  });

  it("does not leak mutable stored records through events or snapshots", () => {
    const tracker = new ProgramStatusTracker();
    const [event] = tracker.feed(osc("state=working:app=cargo"));
    if (event.type !== "report") throw new Error("expected report");
    event.record.state = "error";
    event.records[0].state = "error";
    tracker.getRecords()[0].app = "spoof";
    expect(tracker.getRecords()).toMatchObject([{ state: "working", app: "cargo" }]);
  });
});

describe("incremental VT scanner", () => {
  it("handles every split position, including ESC/ST, and preserves text/report/prompt order", () => {
    const input = `before${osc("state=working", "\x07")}middle${osc("state=done")}\x1b]133;A\x1b\\after`;
    for (let split = 0; split <= input.length; split++) {
      const tracker = new ProgramStatusTracker();
      const events = [...tracker.feed(input.slice(0, split), 1), ...tracker.feed(input.slice(split), 1)];
      expect(events.filter(({ type }) => type !== "text").map(({ type }) => type)).toEqual(["report", "report", "prompt"]);
      expect(events.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("beforemiddleafter");
      expect(tracker.getRecords()).toMatchObject([{ state: "done" }]);
    }
  });

  it("replies to optional queries with fixed supported states/kinds, never echoing report content", () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed(osc("?"))).toEqual([{ type: "query", reply: PROGRAM_STATUS_REPLY }]);
    expect(tracker.feed(PROGRAM_STATUS_REPLY)).toEqual([]);
    expect(tracker.feed(osc("?:state=done:msg=YWJj"))).toMatchObject([{ type: "report", record: { state: "done" } }]);
    expect(tracker.getRecords()).toHaveLength(1);
  });

  it("keeps legacy notifications and printable text in order without exposing any control-string payload", () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed("a\x1b[31mb\x1b]2;waiting for permission\x07c\x1b]777;dssh;done;完成\x07d\x1b]9;notice\x1b\\e")).toEqual([
      { type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" },
      { type: "legacy-osc", body: "777;dssh;done;完成" }, { type: "text", text: "d" },
      { type: "legacy-osc", body: "9;notice" }, { type: "text", text: "e" },
    ]);
  });

  it("does not interpret OSC or RIS nested in other control strings", () => {
    for (const prefix of ["\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x1b]2;"]) {
      const tracker = new ProgramStatusTracker();
      tracker.feed(osc("state=working"));
      const events = tracker.feed(`${prefix}hidden\x1bc${osc("state=error", "\x07")}\x1b\\`);
      expect(events.filter(({ type }) => type === "report" || type === "reset")).toEqual([]);
      expect(tracker.getRecords()).toMatchObject([{ state: "working" }]);
    }
  });

  it("rejects oversized sequences atomically, bounds partial storage, and recovers at termination", () => {
    for (const terminator of ["\x07", "\x1b\\"]) {
      const tracker = new ProgramStatusTracker();
      const overhead = osc("state=working:x=", terminator).length;
      tracker.feed(osc(`state=working:x=${"a".repeat(4096 - overhead)}`, terminator));
      expect(tracker.getRecords()).toMatchObject([{ state: "working" }]);
      tracker.feed(osc(`state=done:x=${"a".repeat(4097 - osc("state=done:x=", terminator).length)}`, terminator));
      expect(tracker.getRecords()).toMatchObject([{ state: "working" }]);
      tracker.feed("\x1b]7501;state=error:x=" + "a".repeat(100_000));
      expect((tracker as unknown as { oscBody: string }).oscBody.length).toBeLessThanOrEqual(4096);
      expect(tracker.feed(`${terminator}${osc("state=done")}`)).toMatchObject([{ type: "report", record: { state: "done" } }]);
    }
  });

  it("counts UTF-8 bytes, drops malformed reports and cancels sequences without leaking their payload", () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed(osc(`state=done:x=${"中".repeat(1400)}`))).toEqual([]);
    expect(tracker.feed("\x1b]7501;state=working\x1b\x07")).toEqual([]);
    expect(tracker.feed("\x1b]7501;state=working\x18" + osc("state=done"))).toMatchObject([{ type: "report", record: { state: "done" } }]);
    expect(tracker.feed(osc("state=working:msg=_") + "safe")).toEqual([{ type: "text", text: "safe" }]);
  });

  it("consumes VT escape intermediates and split string terminators", () => {
    const tracker = new ProgramStatusTracker();
    expect(tracker.feed("\x1b(Bhello\x1bPdo not match blocked\x1b")).toEqual([{ type: "text", text: "hello" }]);
    expect(tracker.feed("\\world")).toEqual([{ type: "text", text: "world" }]);
  });
});
