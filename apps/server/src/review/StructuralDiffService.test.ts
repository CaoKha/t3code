import { describe, expect, it } from "vite-plus/test";

import { toStructuralDiffResult } from "./StructuralDiffService.ts";

describe("toStructuralDiffResult", () => {
  it("converts difftastic byte offsets to string indices", () => {
    const oldContents = 'const s = "héllo";\n';
    const newContents = 'const s = "héllo wörld";\n';
    const result = toStructuralDiffResult(
      {
        status: "changed",
        language: "TypeScript",
        aligned_lines: [
          [0, 0],
          [1, 1],
        ],
        chunks: [
          [
            {
              lhs: { line_number: 0, changes: [{ start: 11, end: 17 }] },
              rhs: { line_number: 0, changes: [{ start: 18, end: 24 }] },
            },
          ],
        ],
      },
      oldContents,
      newContents,
    );
    expect(result.oldChanges).toEqual([{ lineNumber: 0, changes: [{ start: 11, end: 16 }] }]);
    expect(result.newChanges).toEqual([{ lineNumber: 0, changes: [{ start: 17, end: 22 }] }]);
    expect(newContents.slice(17, 22)).toBe("wörld");
  });

  it("marks every line of a created file as added", () => {
    const result = toStructuralDiffResult(
      { status: "created", language: "Text" },
      "",
      "first\n\nthird\n",
    );
    expect(result.status).toBe("changed");
    expect(result.alignedLines).toEqual([
      [null, 0],
      [null, 1],
      [null, 2],
    ]);
    expect(result.newChanges.map((entry) => entry.lineNumber)).toEqual([0, 2]);
    expect(result.oldChanges).toEqual([]);
  });

  it("reports unchanged files without alignment", () => {
    const result = toStructuralDiffResult({ status: "unchanged" }, "a", "a ");
    expect(result).toMatchObject({ status: "unchanged", language: null, alignedLines: [] });
  });
});
