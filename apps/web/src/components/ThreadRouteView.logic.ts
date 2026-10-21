import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { DraftId } from "../composerDraftStore";

/** A thread's chat view, kept mounted while another thread is on screen. */
export interface KeptThreadView {
  /** The view's React key; a draft keeps its own after it becomes a server thread. */
  readonly key: string;
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId: DraftId | null;
}

/**
 * Most recently shown first, up to `capacity`. A thread already kept keeps its key, so the view
 * that carried a draft stays the same view once the draft is promoted. Returns `previous` itself
 * when nothing changed, so it can be compared during render.
 */
export function keepRecentThreadViews(
  previous: ReadonlyArray<KeptThreadView>,
  shown: KeptThreadView | null,
  capacity: number,
): ReadonlyArray<KeptThreadView> {
  if (shown === null) return previous;
  const existing = previous.find((view) => view.threadKey === shown.threadKey);
  if (existing !== undefined && existing === previous[0] && sameView(existing, shown)) {
    return previous;
  }
  const head =
    existing && sameView(existing, shown)
      ? existing
      : { ...shown, key: existing?.key ?? shown.key };
  return [head, ...previous.filter((view) => view !== existing)].slice(0, capacity);
}

function sameView(kept: KeptThreadView, shown: KeptThreadView): boolean {
  return (
    kept.environmentId === shown.environmentId &&
    kept.threadId === shown.threadId &&
    kept.draftId === shown.draftId
  );
}
