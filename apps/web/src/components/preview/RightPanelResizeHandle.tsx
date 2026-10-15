import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  /** The panel edge the handle sits on. */
  side?: "left" | "right";
  className?: string;
}

/**
 * Hit target for resizing a panel via its inner edge: the left edge of a
 * right-anchored panel, or the right edge of a left-anchored one.
 *
 * - Sits on top of the panel's border with a 4px overlap on each side so the
 *   user can grab a few pixels off the edge without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor.
 */
export function RightPanelResizeHandle({ handlers, side = "left", className }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "group absolute inset-y-0 z-20 w-2 cursor-col-resize select-none",
        side === "left" ? "-left-1" : "-right-1",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
