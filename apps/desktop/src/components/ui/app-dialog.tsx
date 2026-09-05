import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTitle } from "./dialog";

/** App-level adapter keeps existing forms and their validation in the shared dialog. */
export function AppDialog({
  children,
  title,
  onClose,
  busy = false,
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="app-dialog"
        aria-describedby={undefined}
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy || event.isComposing || event.keyCode === 229)
            event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
