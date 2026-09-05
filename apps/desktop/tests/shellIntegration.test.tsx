import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { OSC7_HOOK } from "../src/lib/shellIntegration";

const bash =
  process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash";
it.each([
  ["unset PROMPT_COMMAND", ""],
  ["PROMPT_COMMAND=''", ""],
  ["PROMPT_COMMAND='printf ORIGINAL'", "ORIGINAL"],
  ["PROMPT_COMMAND='printf ORIGINAL;'", "ORIGINAL"],
  ["PROMPT_COMMAND=$'printf FIRST;\\nprintf SECOND'", "FIRSTSECOND"],
  ["PROMPT_COMMAND=('printf FIRST' 'printf SECOND;')", "FIRSTSECOND"],
  [
    "declare -a PROMPT_COMMAND=([2]='printf FIRST' [5]='printf SECOND')",
    "FIRSTSECOND",
  ],
])("installs an idempotent Bash directory hook with %s", (setup, original) => {
  const result = spawnSync(bash, ["--noprofile", "--norc"], {
    input: `${setup}\n${OSC7_HOOK.trim()}\n${OSC7_HOOK.trim()}\nfor command in "\${PROMPT_COMMAND[@]}"; do eval "$command"; done\n`,
    encoding: "utf8",
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.startsWith(original)).toBe(true);
  expect(result.stdout.match(/\x1b\]7;file:\/\//g)).toHaveLength(1);
});
