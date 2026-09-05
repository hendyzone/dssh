/** keyCode 229 covers WebView IME events that do not set isComposing. */
export function isComposingKey(
  event: Pick<KeyboardEvent, "isComposing" | "keyCode">,
): boolean {
  return event.isComposing || event.keyCode === 229;
}

export function isAppShortcut(event: KeyboardEvent): boolean {
  if (isComposingKey(event) || event.altKey) return false;
  if (event.ctrlKey && !event.metaKey && event.key === "Tab") return true;
  return (
    (event.ctrlKey || event.metaKey) &&
    !event.shiftKey &&
    /^(w|t|[1-9])$/i.test(event.key)
  );
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      ),
    )
  );
}
