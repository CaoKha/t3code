import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  PullRequestOperationError,
  type ReviewStructuralDiffInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ReviewService from "./ReviewService.ts";
import * as StructuralDiffService from "./StructuralDiffService.ts";

// Captured from `difft --display json` (difftastic 0.71) for the pair below.
const OLD_CONTENTS = 'const s = "héllo";\nlet x = 1;\n';
const NEW_CONTENTS = 'const s = "héllo wörld";\nlet y = 1;\nfoo();\n';
const DIFFT_FIXTURE = JSON.stringify({
  aligned_lines: [
    [0, 0],
    [1, 1],
    [null, 2],
    [2, 3],
  ],
  chunks: [
    [
      {
        rhs: {
          line_number: 2,
          changes: [
            { start: 0, end: 3, content: "foo", highlight: "normal" },
            { start: 3, end: 4, content: "(", highlight: "delimiter" },
            { start: 4, end: 5, content: ")", highlight: "delimiter" },
            { start: 5, end: 6, content: ";", highlight: "normal" },
          ],
        },
      },
      {
        lhs: {
          line_number: 0,
          changes: [
            { start: 10, end: 11, content: '"', highlight: "string" },
            { start: 11, end: 17, content: "héllo", highlight: "string" },
            { start: 17, end: 18, content: '"', highlight: "string" },
          ],
        },
        rhs: {
          line_number: 0,
          changes: [
            { start: 10, end: 11, content: '"', highlight: "string" },
            { start: 11, end: 17, content: "héllo", highlight: "string" },
            { start: 18, end: 24, content: "wörld", highlight: "string" },
            { start: 24, end: 25, content: '"', highlight: "string" },
          ],
        },
      },
      {
        lhs: { line_number: 1, changes: [{ start: 4, end: 5, content: "x", highlight: "normal" }] },
        rhs: { line_number: 1, changes: [{ start: 4, end: 5, content: "y", highlight: "normal" }] },
      },
    ],
  ],
  language: "TypeScript",
  path: "a.ts",
  status: "changed",
});

describe("toStructuralDiffResult", () => {
  it.effect("decodes difftastic JSON and converts byte offsets to string indices", () =>
    Effect.gen(function* () {
      const output = yield* StructuralDiffService.decodeDifftOutput(DIFFT_FIXTURE);
      const result = StructuralDiffService.toStructuralDiffResult(
        output,
        OLD_CONTENTS,
        NEW_CONTENTS,
      );
      expect(result.status).toBe("changed");
      expect(result.language).toBe("TypeScript");
      expect(result.alignedLines).toEqual([
        [0, 0],
        [1, 1],
        [null, 2],
        [2, 3],
      ]);
      expect(result.oldChanges[0]).toEqual({
        lineNumber: 0,
        changes: [
          { start: 10, end: 11 },
          { start: 11, end: 16 },
          { start: 16, end: 17 },
        ],
      });
      const newLine = NEW_CONTENTS.split("\n")[0] ?? "";
      const wörld = result.newChanges[0]?.changes[2];
      expect(newLine.slice(wörld?.start, wörld?.end)).toBe("wörld");
      expect(result.newChanges.map((entry) => entry.lineNumber)).toEqual([0, 1, 2]);
    }),
  );

  it("converts offsets after astral characters", () => {
    const result = StructuralDiffService.toStructuralDiffResult(
      {
        status: "changed",
        chunks: [[{ rhs: { line_number: 0, changes: [{ start: 5, end: 7 }] } }]],
      },
      "",
      "😀 é ok",
    );
    expect(result.newChanges).toEqual([{ lineNumber: 0, changes: [{ start: 3, end: 4 }] }]);
  });

  it("marks every line of a created file as added", () => {
    const result = StructuralDiffService.toStructuralDiffResult(
      { status: "created", language: "Text" },
      "",
      "first\r\n\r\nthird\n",
    );
    expect(result.status).toBe("changed");
    expect(result.alignedLines).toEqual([
      [null, 0],
      [null, 1],
      [null, 2],
    ]);
    expect(result.newChanges).toEqual([
      { lineNumber: 0, changes: [{ start: 0, end: 5 }] },
      { lineNumber: 2, changes: [{ start: 0, end: 5 }] },
    ]);
    expect(result.oldChanges).toEqual([]);
  });

  it("marks every line of a deleted file as removed", () => {
    const result = StructuralDiffService.toStructuralDiffResult(
      { status: "deleted", language: "Text" },
      "gone\n",
      "",
    );
    expect(result.alignedLines).toEqual([[0, null]]);
    expect(result.oldChanges).toEqual([{ lineNumber: 0, changes: [{ start: 0, end: 4 }] }]);
    expect(result.newChanges).toEqual([]);
  });

  it("reports unchanged files without alignment", () => {
    const result = StructuralDiffService.toStructuralDiffResult({ status: "unchanged" }, "a", "a ");
    expect(result).toMatchObject({ status: "unchanged", language: null, alignedLines: [] });
  });

  it("reports binary files as unavailable", () => {
    const result = StructuralDiffService.toStructuralDiffResult(
      { status: "changed", language: "Binary" },
      "a",
      "b",
    );
    expect(result).toMatchObject({ status: "unavailable", reason: "Binary file." });
  });
});

const runOutput = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const pullRequestInput: ReviewStructuralDiffInput = {
  target: {
    _tag: "pullRequest",
    file: {
      projectId: ProjectId.make("project"),
      repository: "owner/repo",
      number: 1,
      changeType: "change",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
    },
  },
};

const makeService = (options: {
  readonly run: ProcessRunner.ProcessRunner["Service"]["run"];
  readonly diffFileContents?: PullRequestService.PullRequestService["Service"]["diffFileContents"];
}) =>
  StructuralDiffService.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, ProcessRunner.ProcessRunner.of(options)),
    Effect.provideService(PullRequestService.PullRequestService, {
      diffFileContents:
        options.diffFileContents ??
        (() => Effect.succeed({ oldContents: OLD_CONTENTS, newContents: NEW_CONTENTS })),
    } as unknown as PullRequestService.PullRequestService["Service"]),
    Effect.provideService(
      ReviewService.ReviewService,
      {} as unknown as ReviewService.ReviewService["Service"],
    ),
    Effect.provideService(
      CheckpointDiffQuery.CheckpointDiffQuery,
      {} as unknown as CheckpointDiffQuery.CheckpointDiffQuery["Service"],
    ),
    Effect.provideService(
      GitVcsDriver.GitVcsDriver,
      {} as unknown as GitVcsDriver.GitVcsDriver["Service"],
    ),
  );

it.layer(NodeServices.layer)("StructuralDiffService", (it) => {
  it.effect("diffs pull request files with difftastic", () =>
    Effect.gen(function* () {
      const runs: Array<ProcessRunner.ProcessRunInput> = [];
      const service = yield* makeService({
        run: (input) => {
          runs.push(input);
          return Effect.succeed(runOutput({ stdout: DIFFT_FIXTURE }));
        },
      });
      const result = yield* service.getStructuralDiff(pullRequestInput);
      expect(result.status).toBe("changed");
      expect(result.newContents).toBe(NEW_CONTENTS);
      expect(runs[0]).toMatchObject({ command: "difft", timeoutBehavior: "timedOutResult" });
      expect(runs[0]?.args.at(-1)?.endsWith("a.ts")).toBe(true);
    }),
  );

  it.effect("answers unavailable when difftastic is missing, times out or fails", () =>
    Effect.gen(function* () {
      const reasonFor = (run: ProcessRunner.ProcessRunner["Service"]["run"]) =>
        makeService({ run }).pipe(
          Effect.flatMap((service) => service.getStructuralDiff(pullRequestInput)),
          Effect.map((result) => [result.status, result.reason]),
        );

      expect(
        yield* reasonFor((input) =>
          Effect.fail(
            new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: new Error("ENOENT"),
            }),
          ),
        ),
      ).toEqual([
        "unavailable",
        "difftastic is not installed. Install it (e.g. `brew install difftastic`) or set T3CODE_DIFFT_PATH.",
      ]);
      expect(
        yield* reasonFor(() => Effect.succeed(runOutput({ code: null, timedOut: true }))),
      ).toEqual(["unavailable", "difftastic timed out on this file."]);
      expect(
        yield* reasonFor(() =>
          Effect.succeed(runOutput({ code: ChildProcessSpawner.ExitCode(2), stderr: "boom\n" })),
        ),
      ).toEqual(["unavailable", "boom"]);
      expect(
        yield* reasonFor((input) =>
          Effect.fail(
            new ProcessRunner.ProcessOutputLimitError({
              command: input.command,
              argumentCount: input.args.length,
              stream: "stdout",
              maxBytes: 1,
              observedBytes: 2,
            }),
          ),
        ),
      ).toEqual(["unavailable", "difftastic output too large."]);
    }),
  );

  it.effect("answers unavailable for binary and oversized files without running difftastic", () =>
    Effect.gen(function* () {
      const run = () => Effect.die("difftastic should not run");
      const binary = yield* makeService({
        run,
        diffFileContents: () => Effect.succeed({ oldContents: "a\0b", newContents: "a" }),
      });
      expect(yield* binary.getStructuralDiff(pullRequestInput)).toMatchObject({
        status: "unavailable",
        reason: "Binary file.",
      });

      const oversized = yield* makeService({
        run,
        diffFileContents: () =>
          Effect.fail(
            new PullRequestOperationError({
              operation: "diffFileContents",
              detail: "The diff file 'src/a.ts' exceeds the 1 MB expansion limit.",
            }),
          ),
      });
      expect(yield* oversized.getStructuralDiff(pullRequestInput)).toMatchObject({
        status: "unavailable",
        reason: "File is larger than 1 MB.",
      });
    }),
  );

  it.effect("reports other pull request read failures as errors", () =>
    Effect.gen(function* () {
      const service = yield* makeService({
        run: () => Effect.die("difftastic should not run"),
        diffFileContents: () =>
          Effect.fail(
            new PullRequestOperationError({ operation: "diffFileContents", detail: "offline" }),
          ),
      });
      const error = yield* service.getStructuralDiff(pullRequestInput).pipe(Effect.flip);
      expect(error.message).toBe("Could not read the pull request files to compare.");
    }),
  );
});
