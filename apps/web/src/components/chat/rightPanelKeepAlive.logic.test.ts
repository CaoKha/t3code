import { describe, expect, it } from "vite-plus/test";

import type { RightPanelSurface } from "../../rightPanelStore";
import { keepRecentSurfaces } from "./rightPanelKeepAlive.logic";

const diff: RightPanelSurface = { id: "diff", kind: "diff" };
const files: RightPanelSurface = { id: "files", kind: "files" };
const file = (relativePath: string): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine: null,
  revealRequestId: 0,
});
const pullRequest = (number: number): RightPanelSurface => ({
  id: `pull-request:${number}`,
  kind: "pull-request",
  projectId: "project",
  repository: "owner/repo",
  number,
});
const terminal: RightPanelSurface = {
  id: "terminal:1",
  kind: "terminal",
  resourceId: "1",
  terminalIds: ["1"],
  activeTerminalId: "1",
};

describe("keepRecentSurfaces", () => {
  it("keeps the surfaces shown, most recent first, up to capacity", () => {
    const open = [diff, files, pullRequest(1), pullRequest(2)];
    let kept = keepRecentSurfaces([], diff, open, 3);
    kept = keepRecentSurfaces(kept, pullRequest(1), open, 3);
    kept = keepRecentSurfaces(kept, files, open, 3);
    kept = keepRecentSurfaces(kept, pullRequest(2), open, 3);

    expect(kept.map((entry) => entry.slot)).toEqual(["pull-request:2", "files", "pull-request:1"]);
  });

  it("returns the same list when nothing changed", () => {
    const kept = keepRecentSurfaces([], diff, [diff], 4);

    expect(keepRecentSurfaces(kept, diff, [diff], 4)).toBe(kept);
  });

  it("drops a surface once it is closed", () => {
    const kept = keepRecentSurfaces([], pullRequest(1), [diff, pullRequest(1)], 4);

    expect(keepRecentSurfaces(kept, diff, [diff], 4).map((entry) => entry.slot)).toEqual(["diff"]);
  });

  it("shares one panel between the explorer and the workspace files it opens", () => {
    const open = [files, file("a.ts"), file("b.ts")];
    let kept = keepRecentSurfaces([], files, open, 4);
    kept = keepRecentSurfaces(kept, file("a.ts"), open, 4);
    kept = keepRecentSurfaces(kept, file("b.ts"), open, 4);

    expect(kept).toEqual([{ slot: "files", surfaceId: "file:b.ts" }]);
  });

  it("leaves surfaces that hold their own sessions out but keeps the others", () => {
    const kept = keepRecentSurfaces([], diff, [diff, terminal], 4);

    expect(keepRecentSurfaces(kept, terminal, [diff, terminal], 4)).toBe(kept);
  });
});
