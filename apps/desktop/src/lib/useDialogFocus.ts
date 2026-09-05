import { useEffect, type RefObject } from "react";
import { isComposingKey } from "./keyboard";

/** Keep Tab navigation inside the open dialog without replacing its initial autofocus. */
export function useDialogFocus(ref: RefObject<HTMLElement>, open = true): void {
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog) return;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "input, select, textarea, button, a[href], [tabindex]",
        ),
      ).filter(
        (element) =>
          element.tabIndex >= 0 &&
          !element.matches(":disabled") &&
          !element.closest("[hidden], [inert]") &&
          element.getAttribute("type") !== "hidden",
      );
    const focusFirst = () =>
      (focusable()[0] ?? dialog).focus({ preventScroll: true });
    if (!dialog.contains(document.activeElement)) focusFirst();

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "Tab" ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isComposingKey(event)
      )
        return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (
        !first ||
        !dialog.contains(document.activeElement) ||
        document.activeElement === dialog ||
        (event.shiftKey
          ? document.activeElement === first
          : document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? (last ?? dialog) : (first ?? dialog)).focus({
          preventScroll: true,
        });
      }
      event.stopPropagation();
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [ref, open]);
}
