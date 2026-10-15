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
