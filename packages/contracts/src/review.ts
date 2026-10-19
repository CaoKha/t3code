import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { TurnCountRange } from "./checkpointDiff.ts";
import { GitCommandError } from "./git.ts";
import { PullRequestDiffFileContentsInput } from "./pullRequest.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  file: Schema.optionalKey(
    Schema.Struct({
      path: Schema.NonEmptyString,
      previousPath: Schema.NullOr(Schema.NonEmptyString),
      sourceKind: Schema.Literals(["working-tree", "branch-range"]),
    }),
  ),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffFileStat = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  files: Schema.optionalKey(Schema.Array(ReviewDiffFileStat)),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

const ReviewDiffFileChangeType = Schema.Literals([
  "change",
  "rename-pure",
  "rename-changed",
  "new",
  "deleted",
]);

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: ReviewDiffFileChangeType,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

/** Selects the old/new file pair that a structural diff compares. */
export const ReviewStructuralDiffTarget = Schema.Union([
  Schema.TaggedStruct("git", {
    file: ReviewDiffFileContentsInput,
  }),
  Schema.TaggedStruct("pullRequest", {
    file: PullRequestDiffFileContentsInput,
  }),
  TurnCountRange.mapFields(
    Struct.assign({
      _tag: Schema.tag("turn"),
      threadId: ThreadId,
      changeType: ReviewDiffFileChangeType,
      oldPath: TrimmedNonEmptyString,
      newPath: TrimmedNonEmptyString,
    }),
    { unsafePreserveChecks: true },
  ),
]);
export type ReviewStructuralDiffTarget = typeof ReviewStructuralDiffTarget.Type;

export const ReviewStructuralDiffInput = Schema.Struct({
  target: ReviewStructuralDiffTarget,
  /** Changes whenever the compared files may have changed, so clients refetch. Ignored by the server. */
  cacheKey: Schema.optionalKey(Schema.String),
});
export type ReviewStructuralDiffInput = typeof ReviewStructuralDiffInput.Type;

/** A token range that difftastic reports as novel on one side of a line. */
export const ReviewStructuralDiffChange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ReviewStructuralDiffChange = typeof ReviewStructuralDiffChange.Type;

export const ReviewStructuralDiffLineChanges = Schema.Struct({
  lineNumber: NonNegativeInt,
  changes: Schema.Array(ReviewStructuralDiffChange),
});
export type ReviewStructuralDiffLineChanges = typeof ReviewStructuralDiffLineChanges.Type;

/**
 * Output of `difft --display json` with both file contents attached.
 * Line numbers are zero-based. `alignedLines` pairs old and new lines in display order;
 * `null` marks a line that only exists on the other side.
 */
export const ReviewStructuralDiffResult = Schema.Struct({
  status: Schema.Literals(["changed", "unchanged", "unavailable"]),
  /** Why difftastic could not produce a diff, when `status` is `unavailable`. */
  reason: Schema.optionalKey(Schema.String),
  language: Schema.NullOr(Schema.String),
  oldContents: Schema.String,
  newContents: Schema.String,
  alignedLines: Schema.Array(
    Schema.Tuple([Schema.NullOr(NonNegativeInt), Schema.NullOr(NonNegativeInt)]),
  ),
  oldChanges: Schema.Array(ReviewStructuralDiffLineChanges),
  newChanges: Schema.Array(ReviewStructuralDiffLineChanges),
});
export type ReviewStructuralDiffResult = typeof ReviewStructuralDiffResult.Type;

export class ReviewStructuralDiffError extends Schema.TaggedError<ReviewStructuralDiffError>()(
  "ReviewStructuralDiffError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
