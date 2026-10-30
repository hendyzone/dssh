const bundledMarkdown = __APP_CHANGELOG__;
import { version as bundledVersion } from "../../package.json";

export { bundledVersion };
export interface ChangelogEntry { version: string; date?: string; body: string }

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z.-]+)?$/;

export function compareVersions(left: string, right: string): number {
  const a = versionPattern.exec(left.replace(/^v/, ""));
  const b = versionPattern.exec(right.replace(/^v/, ""));
  if (!a || !b) throw new Error("Invalid version");
  for (let i = 1; i <= 3; i++) {
    const difference = Number(a[i]) - Number(b[i]);
    if (difference) return difference;
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const x = a[4].split("."), y = b[4].split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn) return Number(x[i]) - Number(y[i]);
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const headings = [...markdown.matchAll(/^##\s+([^\n]+)$/gm)];
  return headings.flatMap((heading, i) => {
    const match = /^v([^\s（(]+)(?:[（(](\d{4}-\d{2}-\d{2})[）)])?\s*$/.exec(heading[1].trim());
    if (!match || !versionPattern.test(match[1])) return [];
    const body = markdown.slice(heading.index! + heading[0].length, headings[i + 1]?.index).trim();
    return body ? [{ version: match[1], date: match[2], body }] : [];
  }).sort((a, b) => compareVersions(b.version, a.version));
}

export function updateEntries(markdown: string, current: string, target: string): ChangelogEntry[] {
  return parseChangelog(markdown).filter(entry =>
    compareVersions(entry.version, current) > 0 && compareVersions(entry.version, target) <= 0);
}

export function installedEntries(version: string): ChangelogEntry[] {
  return parseChangelog(bundledMarkdown).filter(entry => compareVersions(entry.version, version) <= 0);
}

export function fallbackNotes(version: string, notes: string): ChangelogEntry[] {
  const section = parseChangelog(notes).find(entry => entry.version === version.replace(/^v/, ""));
  return [{ version: version.replace(/^v/, ""), body: section?.body ?? notes.trim() }];
}

export async function fetchUpdateEntries(current: string, target: string, signal?: AbortSignal): Promise<ChangelogEntry[]> {
  const version = target.replace(/^v/, "");
  if (!versionPattern.test(version)) throw new Error("Invalid update version");
  const response = await fetch(`https://raw.githubusercontent.com/hendyzone/dssh/v${version}/CHANGELOG.md`, { signal });
  if (!response.ok) throw new Error(`Changelog HTTP ${response.status}`);
  const entries = updateEntries(await response.text(), current, version);
  if (!entries.some(entry => entry.version === version)) throw new Error("Missing target changelog");
  return entries;
}
