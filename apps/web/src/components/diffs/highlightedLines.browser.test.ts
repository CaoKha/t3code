import { describe, expect, it } from "vite-plus/test";

import { highlightedLinesAtAddButton } from "./highlightedLines";

type Row = readonly [
  lineNumber: number,
  lineType: "change-addition" | "change-deletion" | "context",
];

// The rows the diff viewer renders in its shadow root: a gutter cell and a code cell per line.
function mountDiff(rows: ReadonlyArray<Row>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const pre = document.createElement("pre");
  pre.setAttribute("data-diff-type", "unified");
  const code = document.createElement("code");
  code.setAttribute("data-code", "");
  rows.forEach(([lineNumber, lineType], index) => {
    const gutter = document.createElement("div");
    gutter.setAttribute("data-column-number", String(lineNumber));
    gutter.setAttribute("data-line-type", lineType);
    gutter.setAttribute("data-line-index", `${index},${index}`);
    const line = document.createElement("div");
    line.setAttribute("data-line", String(lineNumber));
    line.setAttribute("data-line-type", lineType);
    line.setAttribute("data-line-index", `${index},${index}`);
    line.textContent = `line ${lineNumber}`;
    code.append(gutter, line);
  });
  pre.append(code);
  root.append(pre);
  const gutter = (lineNumber: number) =>
    root.querySelector<HTMLElement>(`[data-column-number="${lineNumber}"]`)!;
  const text = (lineNumber: number) =>
    root.querySelector(`[data-line="${lineNumber}"]`)!.firstChild!;
  return {
    highlight(from: number, to: number) {
      document.getSelection()!.setBaseAndExtent(text(from), 2, text(to), 3);
    },
    pressAddButton(lineNumber: number) {
      const button = document.createElement("button");
      button.setAttribute("data-utility-button", "");
      gutter(lineNumber).append(button);
      let lines: ReturnType<typeof highlightedLinesAtAddButton> = null;
      const read = (event: PointerEvent) => (lines = highlightedLinesAtAddButton(event));
      document.addEventListener("pointerdown", read, { capture: true });
      button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
      document.removeEventListener("pointerdown", read, { capture: true });
      button.remove();
      return lines;
    },
    [Symbol.dispose]() {
      document.getSelection()!.removeAllRanges();
      host.remove();
    },
  };
}

describe("highlightedLinesAtAddButton", () => {
  it("takes every highlighted line when the add button is pressed inside the highlight", () => {
    using diff = mountDiff([
      [10, "context"],
      [11, "change-addition"],
      [12, "change-addition"],
      [13, "context"],
    ]);
    diff.highlight(10, 12);

    expect(diff.pressAddButton(11)).toEqual({ start: 10, side: "additions", end: 12 });
  });

  it("names the side each end of the highlight is on", () => {
    using diff = mountDiff([
      [4, "change-deletion"],
      [4, "change-addition"],
      [5, "change-addition"],
    ]);
    diff.highlight(4, 5);

    expect(diff.pressAddButton(5)).toEqual({
      start: 4,
      side: "deletions",
      end: 5,
      endSide: "additions",
    });
  });

  it("leaves a press outside the highlight to the line it is on", () => {
    using diff = mountDiff([
      [1, "context"],
      [2, "context"],
      [3, "context"],
      [4, "context"],
    ]);
    diff.highlight(1, 2);

    expect(diff.pressAddButton(4)).toBeNull();
  });

  it("leaves a highlight within one line to the line it is on", () => {
    using diff = mountDiff([
      [1, "context"],
      [2, "context"],
    ]);
    diff.highlight(2, 2);

    expect(diff.pressAddButton(2)).toBeNull();
  });
});
