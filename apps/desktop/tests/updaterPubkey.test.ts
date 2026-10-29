import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const confPath = join(dirname(fileURLToPath(import.meta.url)), "../src-tauri/tauri.conf.json");

function loadPubkey(): string {
  const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
    plugins?: { updater?: { pubkey?: string } };
  };
  const pubkey = conf.plugins?.updater?.pubkey;
  if (!pubkey) throw new Error("tauri.conf.json 缺少 plugins.updater.pubkey");
  return pubkey;
}

/** 校验 minisign 公钥与注释 key id 一致（防抄错字符）。 */
export function validateUpdaterPubkey(pubkeyBase64: string): void {
  const outer = Buffer.from(pubkeyBase64.trim(), "base64").toString("utf8");
  const lines = outer.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length < 2) {
    throw new Error("pubkey 必须是 minisign 两行格式");
  }
  const idMatch = lines[0].match(/([0-9A-Fa-f]{16})\s*$/);
  if (!idMatch) {
    throw new Error("pubkey 第一行缺少 16 位 key id");
  }
  const keyId = idMatch[1].toUpperCase();
  const raw = Buffer.from(lines[1], "base64");
  if (raw.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new Error('pubkey 解码后前两字节必须是 "Ed"');
  }
  const idBytes = raw.subarray(2, 10);
  let hex = "";
  for (let i = idBytes.length - 1; i >= 0; i--) {
    hex += idBytes[i].toString(16).padStart(2, "0");
  }
  hex = hex.toUpperCase();
  if (hex !== keyId) {
    throw new Error(`pubkey key id 不匹配（注释 ${keyId}，密钥内 ${hex}）`);
  }
}

describe("updater pubkey in tauri.conf.json", () => {
  it("minisign 公钥与注释 key id 一致", () => {
    expect(() => validateUpdaterPubkey(loadPubkey())).not.toThrow();
  });

  it("变异：抄错字符时 key id 不匹配（应红）", () => {
    const pubkey = loadPubkey();
    const corrupted = pubkey.replace("TUk1", "SUk1");
    expect(() => validateUpdaterPubkey(corrupted)).toThrow(/不匹配/);
  });
});
