import type { ReviewStructuralDiffResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDifftasticRows,
  segmentLine,
  stackDifftasticRows,
  toSyntaxLines,
} from "./difftasticRows";

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join("\n");

const result = (overrides: Partial<ReviewStructuralDiffResult>): ReviewStructuralDiffResult => ({
  status: "changed",
  language: "TypeScript",
  oldContents: "",
  newContents: "",
  alignedLines: [],
  oldChanges: [],
  newChanges: [],
  ...overrides,
});

describe("buildDifftasticRows", () => {
  const twenty = lines(20, "line ");
  const changedAtTen = result({
    oldContents: twenty,
    newContents: twenty.replace("line 10", "line ten"),
    alignedLines: Array.from({ length: 20 }, (_, index) => [index, index] as const),
    oldChanges: [{ lineNumber: 10, changes: [{ start: 5, end: 7 }] }],
    newChanges: [{ lineNumber: 10, changes: [{ start: 5, end: 8 }] }],
  });

  it("keeps context around changes and folds the rest into gaps", () => {
    const rows = buildDifftasticRows(changedAtTen, new Set());
    expect(
      rows.map((row) => (row.kind === "gap" ? `gap:${row.hiddenCount}` : row.old?.lineNumber)),
    ).toEqual(["gap:7", 7, 8, 9, 10, 11, 12, 13, "gap:6"]);
  });

  it("reuses the same row objects when a gap expands", () => {
    const folded = buildDifftasticRows(changedAtTen, new Set());
    const expanded = buildDifftasticRows(changedAtTen, new Set([0]));
    expect(expanded).toContain(folded[1]);
  });

  it("expands a gap by its first hidden row", () => {
    const rows = buildDifftasticRows(changedAtTen, new Set([0]));
    expect(rows.filter((row) => row.kind === "gap")).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "line", old: { lineNumber: 0 } });
  });

  it("treats one-sided rows as changes", () => {
    const rows = buildDifftasticRows(
      result({
        newContents: "a\nb",
        alignedLines: [
          [null, 0],
          [null, 1],
        ],
      }),
      new Set(),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "line" && row.changed)).toBe(true);
  });

  it("strips the carriage return from CRLF lines", () => {
    const rows = buildDifftasticRows(
      result({
        oldContents: "a\r\nb\r\n",
        newContents: "a\r\nB\r\n",
        alignedLines: [
          [0, 0],
          [1, 1],
        ],
        oldChanges: [{ lineNumber: 1, changes: [{ start: 0, end: 1 }] }],
        newChanges: [{ lineNumber: 1, changes: [{ start: 0, end: 1 }] }],
      }),
      new Set(),
    );
    expect(
      rows.map((row) => (row.kind === "line" ? [row.old?.text, row.new?.text] : null)),
    ).toEqual([
      ["a", "a"],
      ["b", "B"],
    ]);
  });

  it("handles a file added from empty contents", () => {
    const rows = buildDifftasticRows(
      result({ oldContents: "", newContents: "x", alignedLines: [[null, 0]] }),
      new Set(),
    );
    expect(rows).toEqual([
      { kind: "line", old: null, new: { lineNumber: 0, text: "x", changes: [] }, changed: true },
    ]);
  });

  it("returns no rows when nothing is aligned", () => {
    expect(buildDifftasticRows(result({}), new Set())).toEqual([]);
  });

  it("clamps context at the first and last lines", () => {
    const aligned = Array.from({ length: 20 }, (_, index) => [index, index] as const);
    const change = [{ start: 0, end: 1 }];
    const first = buildDifftasticRows(
      result({
        oldContents: twenty,
        newContents: twenty,
        alignedLines: aligned,
        oldChanges: [{ lineNumber: 0, changes: change }],
      }),
      new Set(),
    );
    expect(
      first.map((row) => (row.kind === "gap" ? `gap:${row.hiddenCount}` : row.old?.lineNumber)),
    ).toEqual([0, 1, 2, 3, "gap:16"]);
    const last = buildDifftasticRows(
      result({
        oldContents: twenty,
        newContents: twenty,
        alignedLines: aligned,
        newChanges: [{ lineNumber: 19, changes: change }],
      }),
      new Set(),
    );
    expect(
      last.map((row) => (row.kind === "gap" ? `gap:${row.hiddenCount}` : row.new?.lineNumber)),
    ).toEqual(["gap:16", 16, 17, 18, 19]);
  });

  it("sorts each line's changes so they can be swept in order", () => {
    const rows = buildDifftasticRows(
      result({
        oldContents: "abcdef",
        newContents: "abcdef",
        alignedLines: [[0, 0]],
        oldChanges: [
          {
            lineNumber: 0,
            changes: [
              { start: 4, end: 5 },
              { start: 0, end: 1 },
            ],
          },
        ],
      }),
      new Set(),
    );
    expect(rows[0]).toMatchObject({
      old: {
        changes: [
          { start: 0, end: 1 },
          { start: 4, end: 5 },
        ],
      },
    });
  });
});

describe("stackDifftasticRows", () => {
  it("orders old lines before new lines inside a changed run", () => {
    const rows = buildDifftasticRows(
      result({
        oldContents: "a\nb",
        newContents: "A\nB",
        alignedLines: [
          [0, 0],
          [1, 1],
        ],
        oldChanges: [
          { lineNumber: 0, changes: [{ start: 0, end: 1 }] },
          { lineNumber: 1, changes: [{ start: 0, end: 1 }] },
        ],
        newChanges: [
          { lineNumber: 0, changes: [{ start: 0, end: 1 }] },
          { lineNumber: 1, changes: [{ start: 0, end: 1 }] },
        ],
      }),
      new Set(),
    );
    expect(
      stackDifftasticRows(rows).map((entry) => (entry.kind === "gap" ? "gap" : entry.side)),
    ).toEqual(["old", "old", "new", "new"]);
  });

  it("flushes each changed run around unchanged rows and gaps", () => {
    const gap = { kind: "gap", id: 9, hiddenCount: 4 } as const;
    const side = (lineNumber: number, changed = false) => ({
      lineNumber,
      text: "",
      changes: changed ? [{ start: 0, end: 1 }] : [],
    });
    const stacked = stackDifftasticRows([
      { kind: "line", old: side(0, true), new: side(0, true), changed: true },
      { kind: "line", old: null, new: side(1), changed: true },
      { kind: "line", old: side(1), new: side(2), changed: false },
      { kind: "line", old: side(2), new: null, changed: true },
      gap,
      { kind: "line", old: null, new: side(8), changed: true },
    ]);
    expect(
      stacked.map((entry) =>
        entry.kind === "gap"
          ? "gap"
          : `${entry.side}:${entry.row.old?.lineNumber ?? "-"}:${entry.row.new?.lineNumber ?? "-"}`,
      ),
    ).toEqual(["old:0:0", "new:0:0", "new:-:1", "both:1:2", "old:2:-", "gap", "new:-:8"]);
  });
});

describe("segmentLine", () => {
  it("splits plain and novel segments", () => {
    expect(segmentLine("const x = 1;", [{ start: 10, end: 11 }])).toEqual([
      { start: 0, text: "const x = ", novel: false },
      { start: 10, text: "1", novel: true },
      { start: 11, text: ";", novel: false },
    ]);
  });

  it("keeps syntax colors and splits them at change boundaries", () => {
    expect(
      segmentLine(
        "let x = 1;",
        [{ start: 4, end: 5 }],
        [
          { start: 0, end: 3, color: "#c00" },
          { start: 3, end: 10, color: "#111" },
        ],
      ),
    ).toEqual([
      { start: 0, text: "let", novel: false, color: "#c00" },
      { start: 3, text: " ", novel: false, color: "#111" },
      { start: 4, text: "x", novel: true, color: "#111" },
      { start: 5, text: " = 1;", novel: false, color: "#111" },
    ]);
  });

  it("merges overlapping changes into one novel run", () => {
    expect(
      segmentLine("abcdefgh", [
        { start: 0, end: 4 },
        { start: 2, end: 6 },
      ]),
    ).toEqual([
      { start: 0, text: "abcdef", novel: true },
      { start: 6, text: "gh", novel: false },
    ]);
    expect(
      segmentLine("abcdefgh", [
        { start: 0, end: 6 },
        { start: 1, end: 2 },
      ]),
    ).toEqual([
      { start: 0, text: "abcdef", novel: true },
      { start: 6, text: "gh", novel: false },
    ]);
  });

  it("clamps syntax tokens that run past the end of the line", () => {
    expect(
      segmentLine(
        "abcde",
        [],
        [
          { start: 0, end: 3, color: "#a" },
          { start: 3, end: 40, color: "#b" },
          { start: 40, end: 50, color: "#c" },
        ],
      ),
    ).toEqual([
      { start: 0, text: "abc", novel: false, color: "#a" },
      { start: 3, text: "de", novel: false, color: "#b" },
    ]);
  });

  it("returns no segments for an empty line", () => {
    expect(segmentLine("", [{ start: 0, end: 1 }])).toEqual([]);
  });

  it("clamps ranges past the end of the line", () => {
    expect(segmentLine("ab", [{ start: 1, end: 9 }])).toEqual([
      { start: 0, text: "a", novel: false },
      { start: 1, text: "b", novel: true },
    ]);
  });
});

describe("toSyntaxLines", () => {
  it("positions tokens within their line", () => {
    expect(
      toSyntaxLines([[{ content: "const", color: "#a" }, { content: " x" }], [{ content: "y" }]]),
    ).toEqual([
      [
        { start: 0, end: 5, color: "#a" },
        { start: 5, end: 7 },
      ],
      [{ start: 0, end: 1 }],
    ]);
  });
});
