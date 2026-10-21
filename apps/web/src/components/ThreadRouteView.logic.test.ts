import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftId } from "../composerDraftStore";
import { type KeptThreadView, keepRecentThreadViews } from "./ThreadRouteView.logic";

const server = (thread: string): KeptThreadView => ({
  key: `env:${thread}`,
  threadKey: `env:${thread}`,
  environmentId: "env" as never,
  threadId: ThreadId.make(thread),
  draftId: null,
});
const draft = (draftId: string, thread: string): KeptThreadView => ({
  ...server(thread),
  key: draftId,
  draftId: draftId as DraftId,
});

describe("keepRecentThreadViews", () => {
  it("keeps the threads shown, most recent first, up to capacity", () => {
    let kept = keepRecentThreadViews([], server("a"), 3);
    kept = keepRecentThreadViews(kept, server("b"), 3);
    kept = keepRecentThreadViews(kept, server("c"), 3);
    kept = keepRecentThreadViews(kept, server("a"), 3);
    kept = keepRecentThreadViews(kept, server("d"), 3);

    expect(kept.map((view) => view.threadId)).toEqual(["d", "a", "c"]);
  });

  it("returns the same list while the same thread stays on screen", () => {
    const kept = keepRecentThreadViews([], server("a"), 3);

    expect(keepRecentThreadViews(kept, server("a"), 3)).toBe(kept);
    expect(keepRecentThreadViews(kept, null, 3)).toBe(kept);
  });

  it("keeps a thread's record while another one comes to the front", () => {
    const first = keepRecentThreadViews([], server("a"), 3);
    const kept = keepRecentThreadViews(first, server("b"), 3);

    expect(kept[1]).toBe(first[0]);
  });

  it("keeps the draft's view when the draft becomes a server thread", () => {
    const kept = keepRecentThreadViews([], draft("draft-1", "a"), 3);
    const promoted = keepRecentThreadViews(kept, server("a"), 3);

    expect(promoted).toEqual([{ ...server("a"), key: "draft-1" }]);
  });
});
