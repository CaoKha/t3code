/**
 * StructuralDiffService - Structural (syntax-aware) file diffs powered by difftastic.
 *
 * Reads the old/new file pair for a review or turn selection, runs
 * `difft --display json` on it, and returns both contents with difftastic's
 * line alignment and novel token ranges. Offsets are converted from UTF-8
 * bytes to UTF-16 string indices so clients can slice lines directly.
 *
 * @module StructuralDiffService
 */
import {
  ReviewStructuralDiffError,
  type ReviewStructuralDiffInput,
  type ReviewStructuralDiffLineChanges,
  type ReviewStructuralDiffResult,
  type ReviewStructuralDiffTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ReviewService from "./ReviewService.ts";

const MAX_FILE_BYTES = 1024 * 1024;
const DIFFT_TIMEOUT = "20 seconds";
const DIFFT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const DifftChange = Schema.Struct({ start: Schema.Number, end: Schema.Number });
const DifftSide = Schema.Struct({
  line_number: Schema.Number,
  changes: Schema.Array(DifftChange),
});
const DifftOutput = Schema.Struct({
  status: Schema.String,
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
const decodeDifftOutput = Schema.decodeUnknownEffect(Schema.fromJsonString(DifftOutput));

export class StructuralDiffService extends Context.Service<
  StructuralDiffService,
  {
    readonly getStructuralDiff: (
      input: ReviewStructuralDiffInput,
    ) => Effect.Effect<ReviewStructuralDiffResult, ReviewStructuralDiffError>;
  }
>()("t3/review/StructuralDiffService") {}

const fail = (message: string, cause?: unknown) =>
  new ReviewStructuralDiffError({ message, ...(cause === undefined ? {} : { cause }) });

const splitLines = (contents: string) => contents.split("\n");

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Converts a UTF-8 byte offset within `line` to a UTF-16 string index. */
const byteOffsetToIndex = (bytes: Uint8Array, offset: number) =>
  decoder.decode(bytes.subarray(0, Math.max(0, Math.min(offset, bytes.length)))).length;

const collectSideChanges = (
  lines: ReadonlyArray<string>,
  sides: ReadonlyArray<{
    readonly line_number: number;
    readonly changes: ReadonlyArray<{ readonly start: number; readonly end: number }>;
  }>,
): Array<ReviewStructuralDiffLineChanges> => {
  const byLine = new Map<number, Array<{ start: number; end: number }>>();
  for (const side of sides) {
    const line = lines[side.line_number] ?? "";
    const bytes = encoder.encode(line);
    const ranges = byLine.get(side.line_number) ?? [];
    for (const change of side.changes) {
      const start = byteOffsetToIndex(bytes, change.start);
      const end = byteOffsetToIndex(bytes, change.end);
      if (end > start) ranges.push({ start, end });
    }
    byLine.set(side.line_number, ranges);
  }
  return [...byLine.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([lineNumber, changes]) => ({
      lineNumber,
      changes: changes.toSorted((left, right) => left.start - right.start),
    }));
};

/** Every line on one side is novel: used for created and deleted files. */
const wholeFileChanges = (lines: ReadonlyArray<string>) =>
  lines.flatMap((line, lineNumber) =>
    line.length === 0 ? [] : [{ lineNumber, changes: [{ start: 0, end: line.length }] }],
  );

const trimTrailingEmptyLine = (lines: ReadonlyArray<string>) =>
  lines.length > 0 && lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;

export const toStructuralDiffResult = (
  output: DifftOutput,
  oldContents: string,
  newContents: string,
): ReviewStructuralDiffResult => {
  const language = output.language ?? null;
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
  const git = yield* GitVcsDriver.GitVcsDriver;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Desktop apps launched from the Dock may not inherit a shell PATH, so the
  // usual install locations are checked before falling back to PATH lookup.
  const resolveDifftCommand = Effect.gen(function* () {
    const home = yield* HostProcess.HomeDirectory;
    const candidates = [
      process.env.T3CODE_DIFFT_PATH,
      "/opt/homebrew/bin/difft",
      "/usr/local/bin/difft",
      path.join(home, ".cargo", "bin", "difft"),
      path.join(home, ".local", "bin", "difft"),
    ].filter((candidate): candidate is string => Boolean(candidate));
    for (const candidate of candidates) {
      if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return candidate;
      }
    }
    return "difft";
  });

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
      .pipe(Effect.mapError((cause) => fail(`Could not read '${filePath}' at ${ref}.`, cause)));
    return result.stdout;
  });

  const readContents = Effect.fn("StructuralDiffService.readContents")(function* (
    target: ReviewStructuralDiffTarget,
  ) {
    if (target._tag === "git") {
      return yield* review
        .getDiffFileContents(target.file)
        .pipe(Effect.mapError((cause) => fail("Could not read the file pair to compare.", cause)));
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
    return { oldContents, newContents };
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
    const name = path.basename(filePath);
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

    const command = yield* resolveDifftCommand;
    return yield* runner
      .run({
        command,
        args: ["--display", "json", "--color", "never", oldFile, newFile],
        cwd: directory,
        env: { DFT_UNSTABLE: "yes" },
        timeout: DIFFT_TIMEOUT,
        maxOutputBytes: DIFFT_MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.map((result) => ({ _tag: "ran" as const, result })),
        Effect.catchTags({
          ProcessSpawnError: () => Effect.succeed({ _tag: "missing" as const }),
        }),
        Effect.mapError((cause) => fail("difftastic failed.", cause)),
      );
  }, Effect.scoped);

  const getStructuralDiff: StructuralDiffService["Service"]["getStructuralDiff"] = Effect.fn(
    "StructuralDiffService.getStructuralDiff",
  )(function* (input) {
    const { oldContents, newContents } = yield* readContents(input.target);
    const filePath = input.target._tag === "git" ? input.target.file.newPath : input.target.newPath;
    const unavailable = (reason: string): ReviewStructuralDiffResult => ({
      status: "unavailable",
      reason,
      language: null,
      oldContents,
      newContents,
      alignedLines: [],
      oldChanges: [],
      newChanges: [],
    });

    const output = yield* runDifft(filePath, oldContents, newContents);
    if (output._tag === "missing") {
      return unavailable(
        "difftastic is not installed. Install it (e.g. `brew install difftastic`) or set T3CODE_DIFFT_PATH.",
      );
    }
    if (output.result.timedOut) {
      return unavailable("difftastic timed out on this file.");
    }
    if (output.result.code !== 0) {
      return unavailable(output.result.stderr.trim() || "difftastic exited with an error.");
    }

    const parsed = yield* decodeDifftOutput(output.result.stdout.trim()).pipe(
      Effect.mapError((cause) => fail("Could not parse difftastic output.", cause)),
    );
    return toStructuralDiffResult(parsed, oldContents, newContents);
  });

  return StructuralDiffService.of({ getStructuralDiff });
});

export const layer = Layer.effect(StructuralDiffService, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
