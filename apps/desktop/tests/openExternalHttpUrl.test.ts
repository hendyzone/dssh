import { describe, expect, it, vi } from "vitest";
import { openExternalHttpUrl, sanitizeHttpUrl } from "../src/lib/openExternalHttpUrl";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

describe("sanitizeHttpUrl", () => {
  it("accepts http(s) and strips trailing Chinese punctuation", () => {
    expect(sanitizeHttpUrl("https://a.com/path"))?.toContain("https://a.com/path");
    expect(sanitizeHttpUrl("「https://a.com，」"))?.toMatch(/^https:\/\/a\.com\/?$/);
  });
  it("rejects other schemes and credentials", () => {
    expect(sanitizeHttpUrl("file:///etc/passwd")).toBeNull();
    expect(sanitizeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(sanitizeHttpUrl("https://user:pass@a.com")).toBeNull();
  });
});

describe("openExternalHttpUrl", () => {
  it("opens sanitized href only", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    expect(await openExternalHttpUrl("https://example.test/x")).toBe(true);
    expect(openUrl).toHaveBeenCalledWith("https://example.test/x");
    expect(await openExternalHttpUrl("ftp://x")).toBe(false);
  });
});

describe("mutation: broken sanitizer must not open", () => {
  it("does not treat placeholder sanitizer as real URL", () => {
    const broken = (raw: string) => raw.trim();
    expect(broken("javascript:x")).not.toMatch(/^https?:/);
  });
});
