import type { RightPanelSurface } from "../../rightPanelStore";

/** A mounted panel kept for a surface the reader may come back to. */
export interface KeptSurface {
  /** Surfaces that share a slot share one mounted panel. */
  readonly slot: string;
  readonly surfaceId: string;
}

/**
 * The slot whose panel shows this surface, or null for surfaces that already keep their state
 * elsewhere (terminals, browsers and devices hold live sessions outside the panel).
 */
export function keptSurfaceSlot(surface: RightPanelSurface): string | null {
  switch (surface.kind) {
    case "diff":
    case "pull-request":
    case "pull-requests":
      return surface.id;
    // Every workspace file shares the explorer's panel, so its tree survives moving between files.
    case "files":
      return "files";
    case "file":
      return surface.attachment === undefined ? "files" : surface.id;
    case "preview":
    case "terminal":
    case "device":
      return null;
  }
}

/**
 * Most recently shown first, without surfaces that were closed, up to `capacity`. Returns
 * `previous` itself when nothing changed, so it can be compared during render.
 */
export function keepRecentSurfaces(
  previous: ReadonlyArray<KeptSurface>,
  active: RightPanelSurface | null,
  openSurfaces: ReadonlyArray<RightPanelSurface>,
  capacity: number,
): ReadonlyArray<KeptSurface> {
  const openIds = new Set<string>(openSurfaces.map((surface) => surface.id));
  const activeSlot = active === null ? null : keptSurfaceSlot(active);
  const head: ReadonlyArray<KeptSurface> =
    active === null || activeSlot === null ? [] : [{ slot: activeSlot, surfaceId: active.id }];
  const next = [
    ...head,
    ...previous.filter((entry) => entry.slot !== activeSlot && openIds.has(entry.surfaceId)),
  ].slice(0, capacity);
  const unchanged =
    next.length === previous.length &&
    next.every(
      (entry, index) =>
        entry.slot === previous[index]?.slot && entry.surfaceId === previous[index]?.surfaceId,
    );
  return unchanged ? previous : next;
}
