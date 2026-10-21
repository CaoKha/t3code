import type { ReviewStructuralDiffResult } from "@t3tools/contracts";

export interface DifftasticRange {
  readonly start: number;
  readonly end: number;
}

export interface DifftasticSide {
  /** Zero-based line index into the file. */
  readonly lineNumber: number;
  readonly text: string;
  /** Novel token ranges; empty when the line matches the other side. */
  readonly changes: ReadonlyArray<DifftasticRange>;
}

export interface DifftasticLineRow {
  readonly kind: "line";
  readonly old: DifftasticSide | null;
  readonly new: DifftasticSide | null;
  readonly changed: boolean;
}

export interface DifftasticGapRow {
  readonly kind: "gap";
  /** Index of the first hidden aligned row, used as a stable expansion key. */
  readonly id: number;
  readonly hiddenCount: number;
}

export type DifftasticRow = DifftasticLineRow | DifftasticGapRow;

export const DIFFTASTIC_CONTEXT_LINES = 3;

const toLines = (contents: string) => contents.split("\n").map((line) => line.replace(/\r$/, ""));

// Sorted once here so `segmentLine` can sweep each line's ranges in order.
const changesByLine = (entries: ReviewStructuralDiffResult["oldChanges"]) =>
  new Map(
    entries.map((entry) => [
      entry.lineNumber,
      entry.changes.toSorted((left, right) => left.start - right.start),
    ]),
  );

// Aligned rows depend only on the result, so expanding a gap reuses them and memoized rows
// keep their identity.
const alignedRowsCache = new WeakMap<ReviewStructuralDiffResult, Array<DifftasticLineRow>>();

function alignDifftasticRows(result: ReviewStructuralDiffResult): Array<DifftasticLineRow> {
  const cached = alignedRowsCache.get(result);
  if (cached) return cached;
  const oldLines = toLines(result.oldContents);
  const newLines = toLines(result.newContents);
  const oldChanges = changesByLine(result.oldChanges);
  const newChanges = changesByLine(result.newChanges);

  const aligned: Array<DifftasticLineRow> = result.alignedLines.map(([oldIndex, newIndex]) => {
    // A line with no counterpart is wholly added or removed: the row tint says so, as in the
    // standard diff, so its tokens get no emphasis on top (a new file would be all emphasis).
    const old =
      oldIndex === null
        ? null
        : {
            lineNumber: oldIndex,
            text: oldLines[oldIndex] ?? "",
            changes: newIndex === null ? [] : (oldChanges.get(oldIndex) ?? []),
          };
    const next =
      newIndex === null
        ? null
        : {
            lineNumber: newIndex,
            text: newLines[newIndex] ?? "",
            changes: oldIndex === null ? [] : (newChanges.get(newIndex) ?? []),
          };
    const changed =
      old === null || next === null || old.changes.length > 0 || next.changes.length > 0;
    return { kind: "line", old, new: next, changed };
  });
  alignedRowsCache.set(result, aligned);
  return aligned;
}

/**
 * Turns difftastic's alignment into display rows: changed rows plus surrounding
 * context, with runs of unchanged rows folded into gaps unless expanded. Empty
 * when no row changed.
 */
export function buildDifftasticRows(
  result: ReviewStructuralDiffResult,
  expandedGapIds: ReadonlySet<number>,
  contextLines = DIFFTASTIC_CONTEXT_LINES,
): Array<DifftasticRow> {
  const aligned = alignDifftasticRows(result);
  const visible = aligned.map(() => false);
  aligned.forEach((row, index) => {
    if (!row.changed) return;
    const from = Math.max(0, index - contextLines);
    const to = Math.min(aligned.length - 1, index + contextLines);
    for (let cursor = from; cursor <= to; cursor += 1) visible[cursor] = true;
  });
  // Without a changed row there is nothing to show, even if the result says "changed".
  if (!visible.includes(true)) return [];

  const rows: Array<DifftasticRow> = [];
  let index = 0;
  while (index < aligned.length) {
    if (visible[index]) {
      rows.push(aligned[index]!);
      index += 1;
      continue;
    }
    const start = index;
    while (index < aligned.length && !visible[index]) index += 1;
    if (expandedGapIds.has(start)) {
      rows.push(...aligned.slice(start, index));
    } else {
      rows.push({ kind: "gap", id: start, hiddenCount: index - start });
    }
  }
  return rows;
}

/** One stacked-layout line: an old or new line of a changed row, or an unchanged row. */
export interface DifftasticStackedRow {
  readonly kind: "stacked";
  readonly side: "old" | "new" | "both";
  readonly row: DifftasticLineRow;
}

/**
 * Stacked layout: inside each run of changed rows, all old lines come first and
 * then all new lines, like a unified diff hunk.
 */
export function stackDifftasticRows(
  rows: ReadonlyArray<DifftasticRow>,
): Array<DifftasticGapRow | DifftasticStackedRow> {
  const output: Array<DifftasticGapRow | DifftasticStackedRow> = [];
  let pending: Array<DifftasticLineRow> = [];
  const flush = () => {
    for (const row of pending) if (row.old) output.push({ kind: "stacked", side: "old", row });
    for (const row of pending) if (row.new) output.push({ kind: "stacked", side: "new", row });
    pending = [];
  };
  for (const row of rows) {
    if (row.kind === "line" && row.changed) {
      pending.push(row);
      continue;
    }
    flush();
    output.push(row.kind === "gap" ? row : { kind: "stacked", side: "both", row });
  }
  flush();
  return output;
}

/** A syntax-highlighted token, positioned within its line. */
export interface DifftasticSyntaxToken {
  readonly start: number;
  readonly end: number;
  readonly color?: string | undefined;
  readonly fontStyle?: number | undefined;
}

export interface DifftasticSegment {
  readonly start: number;
  readonly text: string;
  /** Inside a token difftastic reports as changed. */
  readonly novel: boolean;
  readonly color?: string | undefined;
  readonly fontStyle?: number | undefined;
}

/**
 * Splits a line at both difftastic change boundaries and syntax token
 * boundaries, so each segment has one change state and one syntax style.
 * Both range lists must be sorted by `start`; changes may overlap.
 */
export function segmentLine(
  text: string,
  changes: ReadonlyArray<DifftasticRange>,
  tokens: ReadonlyArray<DifftasticSyntaxToken> = [],
): Array<DifftasticSegment> {
  const clamp = (value: number) => Math.max(0, Math.min(value, text.length));
  const points = [0, text.length];
  for (const range of changes) points.push(clamp(range.start), clamp(range.end));
  for (const range of tokens) points.push(clamp(range.start), clamp(range.end));
  points.sort((left, right) => left - right);

  const segments: Array<DifftasticSegment> = [];
  let pending: { start: number; end: number; style: Omit<DifftasticSegment, "text"> } | null = null;
  const flush = () => {
    if (pending) segments.push({ ...pending.style, text: text.slice(pending.start, pending.end) });
  };
  let changeIndex = 0;
  let tokenIndex = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    if (end <= start) continue;
    // Ranges that ended before this segment never apply again, so each pointer only moves forward.
    while (changeIndex < changes.length && changes[changeIndex]!.end <= start) changeIndex += 1;
    while (tokenIndex < tokens.length && tokens[tokenIndex]!.end <= start) tokenIndex += 1;
    const change = changes[changeIndex];
    const novel = change !== undefined && change.start <= start;
    const candidate = tokens[tokenIndex];
    const token = candidate !== undefined && candidate.start <= start ? candidate : undefined;
    if (
      pending &&
      pending.style.novel === novel &&
      pending.style.color === token?.color &&
      pending.style.fontStyle === token?.fontStyle
    ) {
      pending.end = end;
      continue;
    }
    flush();
    pending = {
      start,
      end,
      style: {
        start,
        novel,
        ...(token?.color === undefined ? {} : { color: token.color }),
        ...(token?.fontStyle === undefined ? {} : { fontStyle: token.fontStyle }),
      },
    };
  }
  flush();
  return segments;
}

/** Turns Shiki's per-line tokens into line-relative ranges. */
export function toSyntaxLines(
  lines: ReadonlyArray<
    ReadonlyArray<{
      readonly content: string;
      readonly color?: string;
      readonly fontStyle?: number;
    }>
  >,
): Array<Array<DifftasticSyntaxToken>> {
  return lines.map((line) => {
    let cursor = 0;
    return line.map((token) => {
      const start = cursor;
      cursor += token.content.length;
      return { start, end: cursor, color: token.color, fontStyle: token.fontStyle };
    });
  });
}

/**
 * Whether one side of an aligned row gets the added/removed tint: when it has no counterpart
 * (added or removed outright) or holds changed tokens. A line that matches its counterpart
 * stays plain even inside a changed row.
 */
export function isTintedSide(side: DifftasticSide, counterpart: DifftasticSide | null): boolean {
  return counterpart === null || side.changes.length > 0;
}
