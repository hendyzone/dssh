import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// 分段拼接，避免本测试文件自己命中禁词；内容例外清单必须保持为空。
const forbiddenParts: string[][] = [
  ["cowork", "[0-9]"],
  ["100", "\\.66\\."],
  ["mot", "ern"],
  ["nano", "claw"],
  ["/home/", "deng"],
  ["\\b", "deng", "@"],
  ["nu", "ts"],
];
const forbidden = new RegExp(forbiddenParts.map(parts => parts.join("")).join("|"));
const contentAllowlist: RegExp[] = [];
const textExtensions = new Set([".css", ".html", ".js", ".jsx", ".json", ".md", ".py", ".rs", ".sh", ".sql", ".toml", ".ts", ".tsx", ".txt", ".yaml", ".yml"]);

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf-8" });
  return output.split("\n").filter(file => file &&
    !file.includes("/node_modules/") &&
    !file.includes("/vendor/") &&
    textExtensions.has(path.extname(file)));
}

describe("public repository source hygiene", () => {
  it("keeps internal hosts, private addresses and internal mailboxes out of tracked files", () => {
    const hits: string[] = [];
    for (const file of trackedFiles()) {
      const fullPath = path.join(repoRoot, file);
      const text = readFileSync(fullPath, "utf-8");
      if (contentAllowlist.some(allowed => allowed.test(text))) continue;
      text.split("\n").forEach((line, index) => {
        if (forbidden.test(line)) hits.push(`${file}:${index + 1}:${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
