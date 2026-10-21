import type { SelectedLineRange, SelectionSide } from "@pierre/diffs";

interface HighlightedRow {
  readonly lineNumber: number;
  readonly side: SelectionSide;
  readonly rowIndex: number;
}

/**
 * Dragging over the code makes a browser text selection, not the viewer's line selection, so a
 * line's add button pressed inside it would take only the line it sits on. This remembers the
 * highlighted lines at each press, for the selection the press reports to take their place.
 */
export function createAddButtonHighlight() {
  // Set on every press, so a selection reported between presses belongs to the latest one.
  let lines: SelectedLineRange | null = null;
  return {
    press(event: PointerEvent) {
      lines = highlightedLinesAtAddButton(event);
      // The line selection takes over from the text highlight it was made from.
      if (lines !== null) document.getSelection()?.removeAllRanges();
    },
    prefer<Range extends SelectedLineRange | null>(range: Range): SelectedLineRange | Range {
      return lines ?? range;
    },
    /** The viewer callback, handed the highlighted lines in place of the one line pressed. */
    reportTo<Callback extends (range: never, context: never) => void>(
      callback: Callback,
    ): Callback {
      // The viewer's callbacks are overloaded for file and diff items; both take the range first
      // and the item after it, which is all this passes through.
      const call = callback as unknown as (
        range: SelectedLineRange | null,
        context: unknown,
      ) => void;
      return ((range: SelectedLineRange | null, context: unknown) =>
        call(lines ?? range, context)) as unknown as Callback;
    },
  };
}

export function highlightedLinesAtAddButton(event: PointerEvent): SelectedLineRange | null {
  const path = event.composedPath();
  if (!path.some(isAddButton)) return null;
  const root = path.find((target) => target instanceof ShadowRoot);
  const pressed = path.find(
    (target): target is HTMLElement =>
      target instanceof HTMLElement && target.hasAttribute("data-column-number"),
  );
  if (root === undefined || pressed === undefined) return null;
  // The diff renders in a shadow root, which a plain document selection reports as its host.
  const [range] = document.getSelection()?.getComposedRanges({ shadowRoots: [root] }) ?? [];
  if (range === undefined || range.collapsed) return null;
  const first = highlightedRow(range.startContainer, root);
  const last = highlightedRow(range.endContainer, root);
  const pressedRow = highlightedRow(pressed, root);
  if (first === null || last === null || pressedRow === null) return null;
  if (first.rowIndex === last.rowIndex) return null;
  if (pressedRow.rowIndex < first.rowIndex || pressedRow.rowIndex > last.rowIndex) return null;
  return {
    start: first.lineNumber,
    side: first.side,
    end: last.lineNumber,
    ...(last.side === first.side ? {} : { endSide: last.side }),
  };
}

function isAddButton(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.hasAttribute("data-utility-button") || target.hasAttribute("data-gutter-utility-slot"))
  );
}

function highlightedRow(node: Node, root: ShadowRoot): HighlightedRow | null {
  const element = node instanceof Element ? node : node.parentElement;
  const row = element?.closest<HTMLElement>("[data-line], [data-column-number]");
  if (!row || row.getRootNode() !== root) return null;
  const lineNumber = Number(
    row.getAttribute("data-line") ?? row.getAttribute("data-column-number"),
  );
  // "unified,split": a split view lines its two columns up by the second.
  const [unifiedIndex, splitIndex] = (row.getAttribute("data-line-index") ?? "").split(",");
  const split = row.closest("pre")?.getAttribute("data-diff-type") === "split";
  const rowIndex = Number(split ? splitIndex : unifiedIndex);
  if (!Number.isInteger(lineNumber) || !Number.isInteger(rowIndex)) return null;
  return { lineNumber, side: rowSide(row), rowIndex };
}

// The viewer's own reading of which side a row belongs to.
function rowSide(row: HTMLElement): SelectionSide {
  switch (row.getAttribute("data-line-type")) {
    case "change-deletion":
      return "deletions";
    case "change-addition":
      return "additions";
    default:
      return row.closest("[data-code]")?.hasAttribute("data-deletions") ? "deletions" : "additions";
  }
}
