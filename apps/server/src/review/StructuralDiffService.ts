/**
 * StructuralDiffService - Structural (syntax-aware) file diffs powered by difftastic.
 *
 * Reads the old/new file pair for a review, pull request or turn selection, runs
 * `difft --display json` on it, and returns both contents with difftastic's
 * line alignment and novel token ranges. Offsets are converted from UTF-8
 * bytes to UTF-16 string indices so clients can slice lines directly.
 *
 * @module StructuralDiffService
 */
import * as NodeOS from "node:os";

import {
  ReviewStructuralDiffError,
  type ReviewStructuralDiffInput,
  type ReviewStructuralDiffLineChanges,
  type ReviewStructuralDiffResult,
  type ReviewStructuralDiffTarget,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ReviewService from "./ReviewService.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const DIFFT_TIMEOUT = "20 seconds";
const DIFFT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const OVERSIZED_REASON = "File is larger than 1 MB.";
const BINARY_REASON = "Binary file.";

const DifftChange = Schema.Struct({ start: Schema.Number, end: Schema.Number });
const DifftSide = Schema.Struct({
  line_number: Schema.Number,
  changes: Schema.Array(DifftChange),
});
const DifftOutput = Schema.Struct({
  status: Schema.Literals(["unchanged", "changed", "created", "deleted"]),
  language: Schema.optional(Schema.NullOr(Schema.String)),
  aligned_lines: Schema.optional(
    Schema.Array(Schema.Tuple([Schema.NullOr(Schema.Number), Schema.NullOr(Schema.Number)])),
  ),
  chunks: Schema.optional(
    Schema.Array(
      Schema.Array(
        Schema.Struct({
          lhs: Schema.optional(DifftSide),
          rhs: Schema.optional(DifftSide),
        }),
      ),
    ),
  ),
});
type DifftOutput = typeof DifftOutput.Type;
/** @public Exported for fixture tests of difftastic's JSON output. */
export const decodeDifftOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(DifftOutput));

export class StructuralDiffService extends Context.Service<
  StructuralDiffService,
  {
    /** Reads the file pair for a working-tree, branch, pull request or turn target, then diffs it. */
    readonly getStructuralDiff: (
      input: ReviewStructuralDiffInput,
    ) => Effect.Effect<ReviewStructuralDiffResult, ReviewStructuralDiffError>;
  }
>()("t3/review/StructuralDiffService") {}

/** A file pair that difftastic cannot compare, answered as `unavailable` rather than an error. */
class StructuralDiffUnavailable extends Schema.TaggedError<StructuralDiffUnavailable>()(
  "StructuralDiffUnavailable",
  { reason: Schema.String },
) {}

const fail = (message: string, cause?: unknown) =>
  new ReviewStructuralDiffError({ message, ...(cause === undefined ? {} : { cause }) });

/** The messages along an error's cause chain, for recognising upstream read limits. */
const errorText = (error: unknown) => {
  const parts: Array<string> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth += 1) {
    if ("message" in current && typeof current.message === "string") parts.push(current.message);
    if ("detail" in current && typeof current.detail === "string") parts.push(current.detail);
    current = "cause" in current ? current.cause : undefined;
  }
  return parts.join("\n");
};

/** Maps a failed read to `unavailable` when the file is too large or binary to compare. */
const readFailure = (message: string) => (cause: unknown) => {
  const text = errorText(cause);
  if (/exceeds the 1 MB|output exceeded/i.test(text)) {
    return new StructuralDiffUnavailable({ reason: OVERSIZED_REASON });
  }
  if (/binary/i.test(text)) return new StructuralDiffUnavailable({ reason: BINARY_REASON });
  return fail(message, cause);
};

/** Clients only show the reason, so the file pair is not sent back. */
const unavailableResult = (reason: string): ReviewStructuralDiffResult => ({
  status: "unavailable",
  reason,
  language: null,
  oldContents: "",
  newContents: "",
  alignedLines: [],
  oldChanges: [],
  newChanges: [],
});

const splitLines = (contents: string) => contents.split("\n");

const encoder = new TextEncoder();

/** Maps UTF-8 byte offsets within `line` to UTF-16 indices, built in one pass over the line. */
const byteOffsetConverter = (line: string): ((offset: number) => number) => {
  const byteLength = encoder.encode(line).length;
  if (byteLength === line.length) {
    return (offset) => Math.max(0, Math.min(offset, line.length));
  }
  const indices = new Uint32Array(byteLength + 1);
  let byte = 0;
  for (let index = 0; index < line.length;) {
    const codePoint = line.codePointAt(index) ?? 0;
    const width = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
    indices.fill(index, byte, byte + width);
    byte += width;
    index += codePoint > 0xffff ? 2 : 1;
  }
  indices[byteLength] = line.length;
  return (offset) => indices[Math.max(0, Math.min(offset, byteLength))] ?? line.length;
};

const collectSideChanges = (
  lines: ReadonlyArray<string>,
  sides: ReadonlyArray<{
    readonly line_number: number;
    readonly changes: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  }>,
): Array<ReviewStructuralDiffLineChanges> => {
  const byLine = new Map<
    number,
    { toIndex: (offset: number) => number; ranges: Array<{ start: number; end: number }> }
  >();
  for (const side of sides) {
    let entry = byLine.get(side.line_number);
    if (entry === undefined) {
      entry = { toIndex: byteOffsetConverter(lines[side.line_number] ?? ""), ranges: [] };
      byLine.set(side.line_number, entry);
    }
    for (const change of side.changes) {
      const start = entry.toIndex(change.start);
      const end = entry.toIndex(change.end);
      if (end > start) entry.ranges.push({ start, end });
    }
  }
  return [...byLine.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([lineNumber, { ranges }]) => ({
      lineNumber,
      changes: ranges.toSorted((left, right) => left.start - right.start),
    }));
};

/** Every line on one side is novel: used for created and deleted files. */
const wholeFileChanges = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line, lineNumber) => {
    const end = line.endsWith("\r") ? line.length - 1 : line.length;
    return end === 0 ? [] : [{ lineNumber, changes: [{ start: 0, end }] }];
  });

const trimTrailingEmptyLine = (lines: ReadonlyArray<string>) =>
  lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

export const toStructuralDiffResult = (
  output: DifftOutput,
  oldContents: string,
  newContents: string,
): ReviewStructuralDiffResult => {
  const language = output.language ?? null;
  if (language === "Binary") return unavailableResult(BINARY_REASON);
  const oldLines = splitLines(oldContents);
  const newLines = splitLines(newContents);

  if (output.status === "unchanged") {
    return {
      status: "unchanged",
      language,
      oldContents,
      newContents,
      alignedLines: [],
      oldChanges: [],
      newChanges: [],
    };
  }

  if (output.status === "created" || output.status === "deleted") {
    const created = output.status === "created";
    const lines = trimTrailingEmptyLine(created ? newLines : oldLines);
    const changes = wholeFileChanges(lines);
    return {
      status: "changed",
      language,
      oldContents,
      newContents,
      alignedLines: lines.map((_, index) => (created ? [null, index] : [index, null])),
      oldChanges: created ? [] : changes,
      newChanges: created ? changes : [],
    };
  }

  const entries = (output.chunks ?? []).flat();
  return {
    status: "changed",
    language,
    oldContents,
    newContents,
    alignedLines: output.aligned_lines ?? [],
    oldChanges: collectSideChanges(
      oldLines,
      entries.flatMap((entry) => (entry.lhs ? [entry.lhs] : [])),
    ),
    newChanges: collectSideChanges(
      newLines,
      entries.flatMap((entry) => (entry.rhs ? [entry.rhs] : [])),
    ),
  };
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const review = yield* ReviewService.ReviewService;
  const checkpoints = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const difftCommand = yield* Config.String("T3CODE_DIFFT_PATH").pipe(Config.withDefault("difft"));
  // Each run parses both files; leave a core for the rest of the server.
  const difftPermits = yield* Semaphore.make(Math.max(1, NodeOS.availableParallelism() - 1));

  const readFileAtRef = Effect.fn("StructuralDiffService.readFileAtRef")(function* (
    cwd: string,
    ref: string,
    filePath: string,
  ) {
    const result = yield* git
      .execute({
        operation: "StructuralDiffService.readFileAtRef",
        cwd,
        args: ["show", `${ref}:${filePath}`],
        maxOutputBytes: MAX_FILE_BYTES,
      })
      .pipe(Effect.mapError(readFailure(`Could not read '${filePath}' at ${ref}.`)));
    if (result.stdout.includes("\0")) {
      return yield* new StructuralDiffUnavailable({ reason: BINARY_REASON });
    }
    return result.stdout;
  });

  const readContents = Effect.fn("StructuralDiffService.readContents")(function* (
    target: ReviewStructuralDiffTarget,
  ) {
    if (target._tag === "git") {
      const contents = yield* review
        .getDiffFileContents(target.file)
        .pipe(Effect.mapError(readFailure("Could not read the file pair to compare.")));
      return { filePath: target.file.newPath, ...contents };
    }
    if (target._tag === "pullRequest") {
      const contents = yield* pullRequests
        .diffFileContents(target.file)
        .pipe(Effect.mapError(readFailure("Could not read the pull request files to compare.")));
      return { filePath: target.file.newPath, ...contents };
    }
    const refs = yield* checkpoints
      .resolveTurnRefs(target)
      .pipe(Effect.mapError((cause) => fail("Could not resolve the turn checkpoints.", cause)));
    const [oldContents, newContents] = yield* Effect.all(
      [
        target.changeType === "new"
          ? Effect.succeed("")
          : readFileAtRef(refs.cwd, refs.fromCheckpointRef, target.oldPath),
        target.changeType === "deleted"
          ? Effect.succeed("")
          : readFileAtRef(refs.cwd, refs.toCheckpointRef, target.newPath),
      ],
      { concurrency: 2 },
    );
    return { filePath: target.newPath, oldContents, newContents };
  });

  const runDifft = Effect.fn("StructuralDiffService.runDifft")(function* (
    filePath: string,
    oldContents: string,
    newContents: string,
  ) {
    const directory = yield* fileSystem
      .makeTempDirectoryScoped({ prefix: "t3code-difft-" })
      .pipe(Effect.mapError((cause) => fail("Could not create a temporary directory.", cause)));
    // difftastic picks the parser from the file name, so both copies keep it.
    const baseName = path.basename(filePath);
    const name = baseName === "" || baseName === "." || baseName === ".." ? "file" : baseName;
    const oldFile = path.join(directory, "old", name);
    const newFile = path.join(directory, "new", name);
    yield* Effect.all(
      [
        fileSystem.makeDirectory(path.dirname(oldFile)),
        fileSystem.makeDirectory(path.dirname(newFile)),
      ],
      { concurrency: 2 },
    ).pipe(Effect.mapError((cause) => fail("Could not prepare the files to compare.", cause)));
    yield* Effect.all(
      [
        fileSystem.writeFileString(oldFile, oldContents),
        fileSystem.writeFileString(newFile, newContents),
      ],
      { concurrency: 2 },
    ).pipe(Effect.mapError((cause) => fail("Could not prepare the files to compare.", cause)));

    const result = yield* runner
      .run({
        command: difftCommand,
        args: ["--display", "json", "--color", "never", oldFile, newFile],
        cwd: directory,
        env: { DFT_UNSTABLE: "yes" },
        timeout: DIFFT_TIMEOUT,
        timeoutBehavior: "timedOutResult",
        maxOutputBytes: DIFFT_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.catchTags({
          ProcessSpawnError: () =>
            Effect.fail(
              new StructuralDiffUnavailable({
                reason:
                  "difftastic is not installed. Install it (e.g. `brew install difftastic`) or set T3CODE_DIFFT_PATH.",
              }),
            ),
          ProcessOutputLimitError: () =>
            Effect.fail(new StructuralDiffUnavailable({ reason: "difftastic output too large." })),
        }),
        Effect.mapError((cause) =>
          cause._tag === "StructuralDiffUnavailable" ? cause : fail("difftastic failed.", cause),
        ),
      );
    if (result.timedOut) {
      return yield* new StructuralDiffUnavailable({ reason: "difftastic timed out on this file." });
    }
    if (result.code !== 0) {
      return yield* new StructuralDiffUnavailable({
        reason: result.stderr.trim() || "difftastic exited with an error.",
      });
    }
    return result.stdout;
  }, Effect.scoped);

  const diffContents = Effect.fn("StructuralDiffService.diffContents")(function* (input: {
    readonly filePath: string;
    readonly oldContents: string;
    readonly newContents: string;
  }) {
    const { filePath, oldContents, newContents } = input;
    if (oldContents.includes("\0") || newContents.includes("\0")) {
      return unavailableResult(BINARY_REASON);
    }
    const stdout = yield* difftPermits.withPermits(1)(runDifft(filePath, oldContents, newContents));
    const parsed = yield* decodeDifftOutput(stdout.trim()).pipe(
      Effect.mapError((cause) => fail("Could not parse difftastic output.", cause)),
    );
    return toStructuralDiffResult(parsed, oldContents, newContents);
  });

  const getStructuralDiff: StructuralDiffService["Service"]["getStructuralDiff"] = Effect.fn(
    "StructuralDiffService.getStructuralDiff",
  )(
    function* (input) {
      return yield* diffContents(yield* readContents(input.target));
    },
    Effect.catchTags({
      StructuralDiffUnavailable: ({ reason }) => Effect.succeed(unavailableResult(reason)),
    }),
  );

  return StructuralDiffService.of({ getStructuralDiff });
});

export const layer = Layer.effect(StructuralDiffService, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
