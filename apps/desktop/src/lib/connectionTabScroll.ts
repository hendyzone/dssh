/** Keep tab labels inside the horizontal scrollport (not under adjacent chrome). */
export function clampConnectionTabScroll(scroller: HTMLElement): void {
  const tabs = scroller.querySelectorAll<HTMLElement>(".tab");
  if (!tabs.length) return;
  const style = getComputedStyle(scroller);
  const padL = parseFloat(style.paddingLeft) || 0;
  const padR = parseFloat(style.paddingRight) || 0;
  const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  let sl = scroller.scrollLeft;
  const rect = scroller.getBoundingClientRect();
  const first = tabs[0].getBoundingClientRect();
  const last = tabs[tabs.length - 1].getBoundingClientRect();
  if (first.left < rect.left + padL - 0.5) {
    sl -= rect.left + padL - first.left;
  }
  if (last.right > rect.right - padR + 0.5) {
    sl += last.right - (rect.right - padR);
  }
  sl = Math.max(0, Math.min(max, sl));
  if (sl !== scroller.scrollLeft) scroller.scrollLeft = sl;
}

export function tabStripScrollLeftAfterWheel(
  scrollLeft: number,
  deltaY: number,
  unit: number,
  maxScroll: number,
): number {
  return Math.max(0, Math.min(maxScroll, scrollLeft + deltaY * unit));
}
