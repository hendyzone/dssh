import { expect, it } from "vitest";
import { createEchoSuppressor } from "../src/lib/echoSuppress";

const start = "__dssh_osc7";
const end = "\x1b]1337;dssh-init-test\x07";

it("hides wrapped and redrawn internal echo through its explicit completion marker", () => {
  const filter = createEchoSuppressor(start, end);
  const output = filter.process(
    "Welcome\r\n$ " +
      start +
      "(){ printf ...\r\nwrapped\b\b\r\x1b[Kredraw; }\r\n" +
      end +
      "$ ",
  );
  expect(output).toBe("Welcome\r\n$ \r\x1b[2K$ ");
  expect(filter.active).toBe(false);
});

it("handles every byte boundary, including ANSI sequences and the completion marker", () => {
  const filter = createEchoSuppressor(start, end);
  const input =
    "Welcome\r\n$ " +
    "__dssh_\x1b[32mosc7(){ long\r\ncommand; }\x1b[0m\r\n" +
    end +
    "ready$ ";
  const output = [...input].map((char) => filter.process(char)).join("");
  expect(output).toBe("Welcome\r\n$ \r\x1b[2Kready$ ");
});

it("preserves login output when the shell does not echo commands", () => {
  const filter = createEchoSuppressor(start, end);
  expect(filter.process("Welcome\r\n" + end + "$ ")).toBe("Welcome\r\n$ ");
  expect(filter.active).toBe(false);
});

it("forwards standalone terminal queries before the command echo", () => {
  const filter = createEchoSuppressor(start, end);
  expect(filter.process("\x1b[6n")).toBe("\x1b[6n");
});

it("ends filtering before user output in the same chunk even when echo is disabled", () => {
  const filter = createEchoSuppressor(start, end);
  expect(filter.process(end + start + " is defined\r\n")).toBe(
    start + " is defined\r\n",
  );
});

it("leaves later user output untouched even if it contains the hook name", () => {
  const filter = createEchoSuppressor(start, end);
  filter.process(start + "(){}" + end);
  expect(filter.process(start + " is defined\r\n")).toBe(
    start + " is defined\r\n",
  );
});

it("preserves buffered data on timeout instead of hiding unrelated output indefinitely", () => {
  const filter = createEchoSuppressor(start, end);
  const pending = start + "(){}\r\nunsupported shell\r\n";
  expect(filter.process(pending) + filter.flush()).toBe(pending);
  expect(filter.active).toBe(false);
});

it("preserves the existing exact-match filter behavior", () => {
  const filter = createEchoSuppressor("some command");
  expect(filter.process("banner\r\nsome \x1b[32mcommand\r\n$ ")).toBe(
    "banner\r\n\r\n$ ",
  );
});
