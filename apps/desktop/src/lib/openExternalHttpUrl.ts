import { openUrl } from "@tauri-apps/plugin-opener";

const BAD = /[\x00-\x08\x0b-\x1f\x7f]/;
const TRAIL = /[，。；：！？、;,.)\]」』》"'`]+$/;

/** Strip wrappers/punctuation; only http/https with no embedded credentials. */
export function sanitizeHttpUrl(raw: string): string | null {
  let value = String(raw ?? "").trim();
  if (!value || BAD.test(value)) return null;
  for (const [open, close] of [['"', '"'], ["'", "'"], ["`", "`"], ["“", "”"], ["‘", "’"], ["「", "」"], ["（", "）"]] as const) {
    if (value.startsWith(open) && value.endsWith(close) && value.length > open.length + close.length) {
      value = value.slice(open.length, -close.length).trim();
      break;
    }
  }
  value = value.replace(TRAIL, "");
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function openExternalHttpUrl(raw: string): Promise<boolean> {
  const href = sanitizeHttpUrl(raw);
  if (!href) return false;
  await openUrl(href);
  return true;
}
