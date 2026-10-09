export type PageTarget = { kind: "html" | "markdown" | "image"; path: string } | { kind: "url"; url: string };
export interface WebPage {
  id: string;
  title: string;
  target: PageTarget;
  sessionId: string;
}

/** A whole selected path/URL, never shell text or an arbitrary URI scheme. */
export function selectedPage(selection: string): PageTarget | null {
  let value = selection.trim();
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.hostname && !url.username && !url.password ? { kind: "url", url: url.href } : null;
    } catch { return null; }
  }
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== "localhost") return null;
      value = decodeURIComponent(url.pathname);
    } catch { return null; }
  }
  if (!value.startsWith("/") || value.startsWith("//") || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (/\.html?$/i.test(value)) return { kind: "html", path: value };
  if (/\.(md|markdown|mdown)$/i.test(value)) return { kind: "markdown", path: value };
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(value)) return { kind: "image", path: value };
  return null;
}

/** Resolve Markdown asset references on the SSH host, never against the app origin. */
export function markdownImagePath(source: string, documentPath: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(source) || source.startsWith("//")) return null;
  try {
    const base = documentPath.split("/").map(encodeURIComponent).join("/");
    const path = decodeURIComponent(new URL(source, `https://remote.invalid${base}`).pathname);
    return selectedPage(path)?.kind === "image" ? path : null;
  } catch { return null; }
}
