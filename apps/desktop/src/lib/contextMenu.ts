/** Keep native editing commands for real form fields, but never show browser
 * navigation/image commands over the desktop application's panels or canvas. */
export function preventBrowserContextMenu(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const editor = target.closest('input, textarea, [contenteditable="true"]');
  if (editor && !editor.closest(".terminal-view")) return;
  // Do not stop propagation: application menus still receive the event.
  event.preventDefault();
}
