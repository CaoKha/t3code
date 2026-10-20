import {
  CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
  type CheckpointDiffOperation,
  type CheckpointServiceError,
} from "./Errors.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat, type TurnDiffFileSummary } from "./Diffs.ts";

// Windows limits a command line to 32,767 characters. Leave room for the rest of git's arguments.
const MAX_PATHSPEC_CHARS = 24_000;

function batchFilePaths(files: ReadonlyArray<TurnDiffFileSummary>) {
  const batches: string[][] = [];
  let batch: string[] = [];
  let length = 0;
  for (const file of files) {
    const paths = file.previousPath === undefined ? [file.path] : [file.previousPath, file.path];
    const size = paths.reduce((total, path) => total + path.length + 16, 0);
    if (batch.length > 0 && length + size > MAX_PATHSPEC_CHARS) {
      batches.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(...paths);
    length += size;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export interface TurnCheckpointRefs {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;

    /** Resolve the workspace and checkpoint refs that bound a turn range. */
    readonly resolveTurnRefs: (input: {
      readonly threadId: ThreadId;
      readonly fromTurnCount: number;
      readonly toTurnCount: number;
    }) => Effect.Effect<TurnCheckpointRefs, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const crypto = yield* Crypto.Crypto;

  /** Resolves the checkpoint refs and workspace that bound a turn range. */
  const resolveTurnComparison = Effect.fn("CheckpointDiffQuery.resolveTurnComparison")(function* (
    input: {
      readonly threadId: ThreadId;
      readonly fromTurnCount: number;
      readonly toTurnCount: number;
    },
    operation: CheckpointDiffOperation,
    live = false,
  ) {
    const projection = yield* threads.getCheckpointContext(input.threadId).pipe(
      Effect.mapError(
        () =>
          new CheckpointThreadNotFoundError({
            operation,
            threadId: input.threadId,
          }),
      ),
      Effect.withSpan("checkpoint.lookupContext"),
    );
    const completedRunIds = new Set(
      projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
    );
    const readyCheckpoints = projection.checkpoints.filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.appRunOrdinal !== null &&
        checkpoint.runId !== null &&
        completedRunIds.has(checkpoint.runId),
    );
    const maxTurnCount = readyCheckpoints.reduce(
      (max, checkpoint) => Math.max(max, checkpoint.appRunOrdinal ?? 0),
      0,
    );
    if (!live && input.toTurnCount > maxTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: maxTurnCount,
      });
    }

    // A running turn has no checkpoint yet; its changes are compared against the workspace,
    // which the root scope owns.
    const toCheckpoint = live
      ? undefined
      : readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.toTurnCount);
    if (!live && toCheckpoint === undefined) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const toScope = projection.checkpointScopes.find((scope) =>
      toCheckpoint === undefined ? scope.kind === "root_run" : scope.id === toCheckpoint.scopeId,
    );
    if (toScope === undefined) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    // The root scope is shared by every run in this thread. Its runId
    // tracks the latest owner, while ordinal zero stays the baseline.
    const firstScope =
      input.fromTurnCount === 0
        ? projection.checkpointScopes.find((scope) => scope.kind === "root_run")
        : undefined;
    const fromCheckpointRef =
      input.fromTurnCount === 0
        ? firstScope === undefined
          ? undefined
          : yield* checkpointRefForScopeOrdinal({
              scopeId: firstScope.id,
              ordinalWithinScope: 0,
            }).pipe(Effect.provideService(Crypto.Crypto, crypto))
        : readyCheckpoints.find((checkpoint) => checkpoint.appRunOrdinal === input.fromTurnCount)
            ?.ref;
    if (fromCheckpointRef === undefined) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.fromTurnCount,
        checkpoint: "from",
      });
    }

    return { cwd: toScope.cwd, fromCheckpointRef, toCheckpointRef: toCheckpoint?.ref ?? null };
  });

  /**
   * Snapshots the workspace into a throwaway ref, so a running turn diffs through the same
   * checkpoint pipeline as a finished one. Each read gets its own ref and removes it after.
   */
  const withWorkspaceSnapshot = <A, E>(
    input: { readonly cwd: string; readonly threadId: ThreadId },
    use: (ref: CheckpointRef) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const ref = CheckpointRef.make(`refs/t3/live/${Base64Url.encode(input.threadId)}/${id}`);
      return yield* checkpointStore
        .captureCheckpoint({ cwd: input.cwd, checkpointRef: ref })
        .pipe(
          Effect.andThen(use(ref)),
          Effect.ensuring(
            checkpointStore
              .deleteCheckpointRefs({ cwd: input.cwd, checkpointRefs: [ref] })
              .pipe(Effect.ignore),
          ),
        );
    });

  const diffTurn = Effect.fn("CheckpointDiffQuery.diffTurn")(function* (
    input: OrchestrationGetTurnDiffInput,
    operation: CheckpointDiffOperation,
    comparison: CheckpointStore.DiffCheckpointsInput,
  ) {
    const authoredPaths = yield* checkpointStore
      .listAuthoredPaths(comparison)
      .pipe(Effect.orElseSucceed(() => null));
    const files =
      authoredPaths === null
        ? []
        : yield* checkpointStore.diffCheckpoints({ ...comparison, format: "numstat" }).pipe(
            Effect.map(parseTurnDiffFilesFromNumstat),
            Effect.orElseSucceed(() => []),
          );
    const retainedFiles = files.filter((file) => !isGitImport(file, authoredPaths));
    // Select retained paths before generating a patch, so imported bulk cannot exhaust its output limit.
    const diff =
      retainedFiles.length === files.length
        ? yield* checkpointStore
            .diffCheckpoints(comparison)
            .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"))
        : (yield* Effect.forEach(
            batchFilePaths(retainedFiles),
            (filePaths) =>
              checkpointStore
                .diffCheckpoints({ ...comparison, filePaths })
                .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints")),
            { concurrency: 4 },
          )).join("");

    const turnDiff = buildTurnDiffResult(input, diff);
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff;
  });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff = buildTurnDiffResult(input, "");
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const live = input.live === true;
      const resolved = yield* resolveTurnComparison(input, operation, live);
      const { cwd, fromCheckpointRef, toCheckpointRef } = resolved;
      if (toCheckpointRef === null) {
        return yield* withWorkspaceSnapshot({ cwd, threadId: input.threadId }, (snapshotRef) =>
          diffTurn(input, operation, {
            cwd,
            fromCheckpointRef,
            toCheckpointRef: snapshotRef,
            // A thread's first turn can start before its baseline checkpoint lands.
            fallbackFromToHead: true,
            ignoreWhitespace,
          }),
        );
      }
      return yield* diffTurn(input, operation, {
        cwd,
        fromCheckpointRef,
        toCheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      });
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const turnDiff = yield* getTurnDiff({
      threadId: input.threadId,
      fromTurnCount: 0,
      toTurnCount: input.toTurnCount,
      ignoreWhitespace,
    });
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  const resolveTurnRefs: CheckpointDiffQuery["Service"]["resolveTurnRefs"] = (input) => {
    const operation = "CheckpointDiffQuery.resolveTurnRefs";
    return resolveTurnComparison(input, operation).pipe(
      Effect.flatMap(({ toCheckpointRef, ...refs }) =>
        toCheckpointRef === null
          ? Effect.fail(
              new CheckpointRefUnavailableError({
                operation,
                threadId: input.threadId,
                turnCount: input.toTurnCount,
                checkpoint: "to",
              }),
            )
          : Effect.succeed({ ...refs, toCheckpointRef }),
      ),
    );
  };

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
    resolveTurnRefs,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
