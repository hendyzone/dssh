import { useEffect, type ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./dropdown-menu";

/** A context-menu adapter for terminal and tree coordinates; Radix handles focus and edges. */
export function PositionedMenu({
  x,
  y,
  label,
  onClose,
  children,
}: {
  x: number;
  y: number;
  label?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    window.addEventListener("blur", onClose);
    return () => window.removeEventListener("blur", onClose);
  }, [onClose]);
  return (
    <DropdownMenu
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden="true"
          style={{
            position: "fixed",
            left: x,
            top: y,
            width: 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label={label}
        aria-labelledby={undefined}
        align="start"
        sideOffset={2}
        collisionPadding={8}
        className="min-w-44 z-[1200]"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
export const MenuItem = DropdownMenuItem;
