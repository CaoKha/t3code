/**
 * SourceBuildUpdater - The ElectronUpdater service for apps built from a fork.
 *
 * Enabled by `<T3 home>/source-build.json`:
 * `{ "repoPath": "/path/to/fork", "upstreamRepository": "pingdotgg/t3code" }` (macOS only).
 *
 * - Check: finds the newest upstream GitHub release on the selected channel.
 * - Download: runs `scripts/source-update.sh` in the fork, which merges the release tag
 *   and builds the app. A merge conflict aborts the merge and reports the files.
 * - Install: swaps the running bundle for the built one after the app quits, then relaunches.
 *
 * @module SourceBuildUpdater
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

export const SOURCE_BUILD_CONFIG_FILE = "source-build.json";
const DEFAULT_UPSTREAM_REPOSITORY = "pingdotgg/t3code";
const UPDATE_SCRIPT = "scripts/source-update.sh";
const CONFLICT_EXIT_CODE = 3;

const SourceBuildConfigSchema = Schema.Struct({
  repoPath: Schema.NonEmptyString,
  upstreamRepository: Schema.optional(Schema.String),
});
const decodeSourceBuildConfig = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SourceBuildConfigSchema),
);

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  body: Schema.optional(Schema.NullOr(Schema.String)),
});
type GitHubRelease = typeof GitHubRelease.Type;
const decodeReleases = Schema.decodeUnknownEffect(Schema.Array(GitHubRelease));

export interface SourceBuildConfig {
  readonly repoPath: string;
  readonly upstreamRepository: string;
}

interface Release {
  readonly tag: string;
  readonly version: string;
  readonly notes: string | null;
}

const versionParts = (version: string) =>
  (version.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));

/** Numeric, field-by-field order: `0.0.46-nightly.20261015.3145` < `0.0.46-nightly.20261016.1`. */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The newest release on a channel: nightly tags for nightly, stable releases otherwise. */
export function selectLatestRelease(
  releases: ReadonlyArray<GitHubRelease>,
  channel: string,
): Release | null {
  return releases
    .filter((release) => !release.draft)
    .filter((release) =>
      channel === "nightly"
        ? release.tag_name.includes("-nightly.")
        : !release.prerelease && !release.tag_name.includes("-"),
    )
    .map((release) => ({
      tag: release.tag_name,
      version: release.tag_name.replace(/^v/, ""),
      notes: release.body ?? null,
    }))
    .reduce<Release | null>(
      (latest, candidate) =>
        latest === null || compareVersions(candidate.version, latest.version) > 0
          ? candidate
          : latest,
      null,
    );
}

/** The message shown on the update button when the fork conflicts with the release. */
export function describeConflict(tag: string, repoPath: string, files: ReadonlyArray<string>) {
  return (
    `Merge conflict: upstream ${tag} conflicts with your changes in ${files.join(", ")}. ` +
    `Your branch was left unchanged. Run \`git merge ${tag}\` in ${repoPath}, resolve the ` +
    `conflicts and commit, then check for updates again.`
  );
}

export type UpdateScriptEvent =
  | { readonly _tag: "progress"; readonly percent: number }
  | { readonly _tag: "conflict"; readonly file: string }
  | { readonly _tag: "error"; readonly message: string }
  | { readonly _tag: "staged"; readonly appPath: string };

/** Parses one stdout line of `scripts/source-update.sh`. */
export function parseUpdateScriptLine(line: string): UpdateScriptEvent | null {
  const separator = line.indexOf(" ");
  if (separator <= 0) return null;
  const marker = line.slice(0, separator);
  const value = line.slice(separator + 1).trim();
  if (value.length === 0) return null;
  switch (marker) {
    case "PROGRESS": {
      const percent = Number(value);
      return Number.isFinite(percent) ? { _tag: "progress", percent } : null;
    }
    case "CONFLICT":
      return { _tag: "conflict", file: value };
    case "ERROR":
      return { _tag: "error", message: value };
    case "STAGED_APP":
      return { _tag: "staged", appPath: value };
    default:
      return null;
  }
}

const t3Home = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const path = yield* Path.Path;
  return environment.T3CODE_HOME?.trim() || path.join(home, ".t3");
});

/** Reads the source-build marker; absent or invalid markers keep the regular updater. */
export const readSourceBuildConfig = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "darwin") return Option.none<SourceBuildConfig>();
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(yield* t3Home, SOURCE_BUILD_CONFIG_FILE);
  return yield* fileSystem.readFileString(configPath).pipe(
    Effect.flatMap(decodeSourceBuildConfig),
    Effect.map((config) =>
      Option.some<SourceBuildConfig>({
        repoPath: config.repoPath,
        upstreamRepository: config.upstreamRepository?.includes("/")
          ? config.upstreamRepository
          : DEFAULT_UPSTREAM_REPOSITORY,
      }),
    ),
    Effect.orElseSucceed(() => Option.none<SourceBuildConfig>()),
  );
});

type Listener = (...args: Array<unknown>) => void;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("SourceBuildUpdater.make")(function* (config: SourceBuildConfig) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronApp = yield* ElectronApp.ElectronApp;
  const appVersion = (yield* electronApp.metadata.pipe(Effect.orDie)).appVersion;
  const executablePath = yield* HostProcess.ExecutablePath;
  const logPath = path.join(yield* t3Home, "userdata", "logs", "source-update.log");

  const listeners = new Map<string, Set<Listener>>();
  const emit = (eventName: string, ...args: Array<unknown>) =>
    Effect.sync(() => {
      for (const listener of listeners.get(eventName) ?? []) listener(...args);
    });

  let channel: string | null = null;
  let pending: Release | null = null;
  let staged: { readonly version: string; readonly appPath: string } | null = null;

  const checkForUpdates = Effect.gen(function* () {
    yield* emit("checking-for-update");
    const releases = yield* httpClient
      .get(`https://api.github.com/repos/${config.upstreamRepository}/releases?per_page=50`, {
        headers: { accept: "application/vnd.github+json" },
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeReleases),
      );
    const latest = selectLatestRelease(releases, channel ?? "latest");
    if (latest === null || compareVersions(latest.version, appVersion) <= 0) {
      pending = null;
      yield* emit("update-not-available");
      return;
    }
    pending = latest;
    yield* emit("update-available", { version: latest.version, releaseNotes: latest.notes });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
          channel,
          detail: `Could not read releases from github.com/${config.upstreamRepository}.`,
          cause,
        }),
    ),
  );

  const downloadFailure = (detail: string, cause?: unknown) =>
    new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel, detail, cause });

  const runUpdateScript = (release: Release) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make("/bin/bash", [UPDATE_SCRIPT, release.tag, release.version], {
            cwd: config.repoPath,
            stdout: "pipe",
            stderr: "pipe",
          }),
        );
        const conflicts: Array<string> = [];
        const output: Array<string> = [];
        let errorMessage: string | null = null;
        let stagedApp: string | null = null;
        const [, , exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) => {
                output.push(line);
                const event = parseUpdateScriptLine(line);
                if (event === null) return Effect.void;
                switch (event._tag) {
                  case "progress":
                    return emit("download-progress", { percent: event.percent });
                  case "conflict":
                    return Effect.sync(() => conflicts.push(event.file));
                  case "error":
                    return Effect.sync(() => {
                      errorMessage = event.message;
                    });
                  case "staged":
                    return Effect.sync(() => {
                      stagedApp = event.appPath;
                    });
                }
              }),
            ),
            handle.stderr.pipe(
              Stream.decodeText(),
              Stream.splitLines,
              Stream.runForEach((line) => Effect.sync(() => output.push(line))),
            ),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        yield* fileSystem.makeDirectory(path.dirname(logPath), { recursive: true });
        yield* fileSystem.writeFileString(logPath, `${output.join("\n")}\n`);
        return { exitCode: Number(exitCode), conflicts, errorMessage, stagedApp } as {
          exitCode: number;
          conflicts: Array<string>;
          errorMessage: string | null;
          stagedApp: string | null;
        };
      }),
    );

  const downloadUpdate = Effect.gen(function* () {
    const release = pending;
    if (release === null) return yield* downloadFailure("No update is available to build.");
    const scriptPath = path.join(config.repoPath, UPDATE_SCRIPT);
    if (!(yield* fileSystem.exists(scriptPath).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* downloadFailure(`${UPDATE_SCRIPT} was not found in ${config.repoPath}.`);
    }
    const result = yield* runUpdateScript(release).pipe(
      Effect.mapError((cause) => downloadFailure(`Could not run ${UPDATE_SCRIPT}.`, cause)),
    );
    if (result.exitCode === CONFLICT_EXIT_CODE && result.conflicts.length > 0) {
      return yield* downloadFailure(
        describeConflict(release.tag, config.repoPath, result.conflicts),
      );
    }
    if (result.exitCode !== 0 || result.stagedApp === null) {
      return yield* downloadFailure(
        `Building ${release.tag} from source failed: ${
          result.errorMessage ?? `exit code ${result.exitCode}`
        }. See ${logPath}.`,
      );
    }
    staged = { version: release.version, appPath: result.stagedApp };
    yield* emit("update-downloaded", { version: release.version });
  });

  // The helper backgrounds itself so it outlives this app: it waits for the app
  // ($PPID of the launcher) to exit, swaps the bundle and opens the new one.
  const INSTALL_SCRIPT = [
    'app_pid="$PPID"',
    "(",
    "  trap '' HUP",
    '  while kill -0 "$app_pid" 2>/dev/null; do sleep 0.5; done',
    '  rm -rf "$2.previous"',
    '  mv "$2" "$2.previous" || exit 1',
    '  if ditto "$1" "$2"; then rm -rf "$2.previous"; else rm -rf "$2"; mv "$2.previous" "$2"; fi',
    '  xattr -dr com.apple.quarantine "$2" 2>/dev/null',
    '  [ "$3" = "1" ] && open "$2"',
    ") </dev/null >/dev/null 2>&1 &",
  ].join("\n");

  const quitAndInstall = ({
    isSilent,
    isForceRunAfter,
  }: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }) =>
    Effect.gen(function* () {
      const update = staged;
      if (update === null) return yield* Effect.fail("No built update is ready to install.");
      // .../T3 Code (Nightly).app/Contents/MacOS/<binary>
      const bundlePath = path.resolve(executablePath, "..", "..", "..");
      if (!bundlePath.endsWith(".app")) {
        return yield* Effect.fail(
          `Could not locate the running app bundle from ${executablePath}.`,
        );
      }
      yield* Effect.scoped(
        spawner
          .spawn(
            ChildProcess.make(
              "/bin/bash",
              [
                "-c",
                INSTALL_SCRIPT,
                "t3-source-install",
                update.appPath,
                bundlePath,
                isForceRunAfter ? "1" : "0",
              ],
              { stdout: "ignore", stderr: "ignore", detached: false },
            ),
          )
          .pipe(Effect.flatMap((handle) => handle.exitCode)),
      );
      yield* electronApp.quit;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      ),
    );

  return ElectronUpdater.ElectronUpdater.of({
    selfConfigured: true,
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: (next) =>
      Effect.sync(() => {
        channel = next;
      }),
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    on: (eventName, listener) => {
      const untypedListener = listener as unknown as Listener;
      return Effect.acquireRelease(
        Effect.sync(() => {
          const set = listeners.get(eventName) ?? new Set<Listener>();
          set.add(untypedListener);
          listeners.set(eventName, set);
        }),
        () => Effect.sync(() => listeners.get(eventName)?.delete(untypedListener)),
      ).pipe(Effect.asVoid);
    },
  });
});
