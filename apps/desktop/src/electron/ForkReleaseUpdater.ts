/**
 * ForkReleaseUpdater - The ElectronUpdater service for builds of a T3 Code fork.
 *
 * A fork's CI (.github/workflows/fork-release.yml) publishes each push as a GitHub
 * release and points the fixed `channel` release at it: that release holds
 * `latest.json` (the newest build, with each asset's URL and SHA-256) and
 * `upstream-status.json` (written by fork-upstream-sync.yml). Both are read through
 * release download URLs, which the GitHub API rate limit does not cover.
 *
 * Builds made there carry the fork's repository (T3CODE_FORK_RELEASE_REPOSITORY at
 * build time), and this updater, on macOS:
 *
 * - Check: reads `latest.json`. When it names a newer version, that is the update.
 *   Otherwise it reports `upstream-status.json` when upstream could not be merged.
 * - Download: fetches the zip, verifies its size and SHA-256 and unpacks it.
 * - Install: swaps the running bundle for the new one after the app quits, then reopens it.
 *
 * The fork publishes a single train, so the update channel only labels errors.
 *
 * @module ForkReleaseUpdater
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";

declare const __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__: string | undefined;

/** The fixed release whose assets CI keeps current with `gh release upload --clobber`. */
export const CHANNEL_TAG = "channel";
export const LATEST_MANIFEST = "latest.json";
export const UPSTREAM_STATUS_FILE = "upstream-status.json";

const USER_AGENT = "t3code-fork-updater";
const REQUEST_TIMEOUT = Duration.seconds(20);
/** A download that delivers no bytes for this long has stalled. */
const DOWNLOAD_IDLE_TIMEOUT = Duration.seconds(60);

const ManifestAsset = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  sha256: Schema.String,
});

/** `latest.json`: the newest build of the fork, written by fork-release.yml. */
export const ForkManifest = Schema.Struct({
  version: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
  /** Keyed by `<platform>-<arch>`, e.g. `darwin-arm64` and `linux-x64`. */
  assets: Schema.Record(Schema.String, ManifestAsset),
});
export type ForkManifest = typeof ForkManifest.Type;
const decodeManifest = Schema.decodeUnknownEffect(ForkManifest);

/** `upstream-status.json`: the last upstream sync, written by fork-upstream-sync.yml. */
export const UpstreamStatus = Schema.Struct({
  status: Schema.String,
  tag: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String)),
  detail: Schema.optional(Schema.String),
});
export type UpstreamStatus = typeof UpstreamStatus.Type;
const decodeUpstreamStatus = Schema.decodeUnknownEffect(UpstreamStatus);

/** A step of a check or download that failed, with a message written for the user. */
export class ForkUpdateStepError extends Schema.TaggedError<ForkUpdateStepError>()(
  "ForkUpdateStepError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ForkUpdate {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  readonly asset: { readonly name: string; readonly url: string; readonly sha256: string };
}

export type ManifestSelection =
  | { readonly _tag: "UpdateAvailable"; readonly update: ForkUpdate }
  | { readonly _tag: "UpToDate" }
  | { readonly _tag: "Invalid"; readonly reason: string };

export const channelFileUrl = (repository: string, fileName: string) =>
  `https://github.com/${repository}/releases/download/${CHANNEL_TAG}/${fileName}`;

/** Safe as a single path segment: no separators, and never `.` or `..`. */
export const isSafeFileName = (value: string) => /^\w[\w.-]*$/.test(value);

/** A version that orders as semver and is safe to use as a directory name. */
export const isSafeVersion = (value: string) =>
  isSafeFileName(value) && parseSemver(value) !== null;

export const isSha256 = (value: string) => /^[0-9a-f]{64}$/i.test(value);

/** Semver order, prerelease fields compared numerically: `…20261015.10009` < `…20261016.10010`. */
export const isNewerVersion = (candidate: string, current: string) =>
  compareSemverVersions(candidate, current) > 0;

/** Picks the update `latest.json` offers this platform, if it is newer than the running app. */
export function selectUpdate(
  manifest: ForkManifest,
  options: {
    readonly repository: string;
    readonly appVersion: string;
    readonly platformKey: string;
  },
): ManifestSelection {
  const invalid = (reason: string): ManifestSelection => ({
    _tag: "Invalid",
    reason: `The fork update channel is invalid: ${reason}`,
  });
  if (!isSafeVersion(manifest.version)) {
    return invalid(`${LATEST_MANIFEST} names the version "${manifest.version}".`);
  }
  if (!isNewerVersion(manifest.version, options.appVersion)) return { _tag: "UpToDate" };
  const asset = manifest.assets[options.platformKey];
  if (asset === undefined) {
    return invalid(`${manifest.tag} has no build for ${options.platformKey}.`);
  }
  if (!isSafeFileName(asset.name)) return invalid(`the asset name "${asset.name}" is not allowed.`);
  if (!isSha256(asset.sha256)) return invalid(`${asset.name} has no valid SHA-256.`);
  if (!asset.url.startsWith(`https://github.com/${options.repository}/releases/download/`)) {
    return invalid(`${asset.name} is not hosted on github.com/${options.repository}.`);
  }
  return {
    _tag: "UpdateAvailable",
    update: {
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      asset: { name: asset.name, url: asset.url, sha256: asset.sha256.toLowerCase() },
    },
  };
}

/** The message shown on the update button when upstream could not be merged into the fork. */
export function describeConflict(repository: string, tag: string, files: ReadonlyArray<string>) {
  const where = files.length > 0 ? ` in ${files.join(", ")}` : "";
  return (
    `Merge conflict: upstream ${tag} conflicts with your changes${where}. ` +
    `Run \`git fetch upstream --tags && git merge ${tag}\` in your clone of ${repository}, ` +
    `resolve the conflicts and push; CI then publishes an update.`
  );
}

/** The message shown when upstream adds workflows, which the sync does not push unreviewed. */
export function describeNeedsReview(repository: string, tag: string, files: ReadonlyArray<string>) {
  const which = files.length > 0 ? ` (${files.join(", ")})` : "";
  return (
    `Needs review: upstream ${tag} adds GitHub workflows${which}, so it was not merged automatically. ` +
    `Disable any you do not want under Actions in ${repository}, then run ` +
    `\`git fetch upstream --tags && git merge ${tag}\` in your clone and push; CI then publishes an update.`
  );
}

/** What to tell the user about the last upstream sync; nothing when it merged cleanly. */
export function describeUpstreamStatus(
  repository: string,
  status: UpstreamStatus,
): Option.Option<string> {
  const files = status.files ?? [];
  switch (status.status) {
    case "conflict":
      return Option.some(describeConflict(repository, status.tag, files));
    case "needs-review":
      return Option.some(describeNeedsReview(repository, status.tag, files));
    case "push-failed":
      return Option.some(
        `Upstream sync failed: ${status.tag} merged cleanly but could not be pushed to ${repository}` +
          `${status.detail === undefined ? "" : ` (${status.detail})`}. ` +
          `Check the "Fork upstream sync" workflow run and its FORK_SYNC_SSH_KEY.`,
      );
    default:
      return Option.none();
  }
}

/** A user-facing reason for an HTTP status from a release download URL. */
export function describeHttpStatus(url: string, status: number) {
  if (status === 404) return `${url} was not found: the fork's CI has not published it yet.`;
  if (status === 403 || status === 429) {
    return `GitHub refused ${url} (HTTP ${status}, likely rate limiting). Try again later.`;
  }
  return `GitHub answered HTTP ${status} for ${url}.`;
}

/** The hash in `shasum -a 256 <file>` output. */
export function parseShasumOutput(stdout: string): string | null {
  const hash = stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  return isSha256(hash) ? hash : null;
}

/**
 * Why the running bundle cannot be replaced in place, if it cannot. Checked before
 * quitting, so a failed install leaves the app running and recoverable.
 */
export function describeInstallBlocker(bundlePath: string): string | null {
  if (!bundlePath.endsWith(".app")) {
    return `Could not locate the running app bundle (${bundlePath}).`;
  }
  if (bundlePath.includes("/AppTranslocation/")) {
    return (
      "macOS is running T3 Code from a temporary read-only copy (App Translocation). " +
      "Move T3 Code to /Applications, open it from there and install the update again."
    );
  }
  return null;
}

/**
 * The fork whose releases this build updates from. Packaged apps only use the
 * repository baked in by the fork's CI; unpackaged (development) runs may override it
 * with T3CODE_FORK_RELEASE_REPOSITORY.
 */
export function resolveForkReleaseRepository(options: {
  readonly platform: string;
  readonly isPackaged: boolean;
  readonly runtimeOverride: string | undefined;
  readonly buildTime: string | undefined;
}): Option.Option<string> {
  if (options.platform !== "darwin") return Option.none();
  const repository =
    (options.isPackaged ? "" : options.runtimeOverride?.trim()) || options.buildTime?.trim() || "";
  return /^[\w.-]+\/[\w.-]+$/.test(repository) ? Option.some(repository) : Option.none();
}

export const forkReleaseRepository = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const isPackaged = yield* electronApp.metadata.pipe(
    Effect.map((metadata) => metadata.isPackaged),
    // Unknown counts as packaged: only the baked-in repository is trusted then.
    Effect.orElseSucceed(() => true),
  );
  return resolveForkReleaseRepository({
    platform: yield* HostProcess.Platform,
    isPackaged,
    runtimeOverride: (yield* HostProcess.Environment).T3CODE_FORK_RELEASE_REPOSITORY,
    buildTime:
      typeof __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__ === "undefined"
        ? undefined
        : __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__,
  });
});

/**
 * Swaps the bundle once the app has quit. Arguments: $1 the staged app, $2 the running
 * bundle, $3 "1" to reopen, $4 the downloaded version's folder (removed after success).
 *
 * The copy goes to "$2.new" first, so the running bundle is only moved aside once a
 * complete replacement exists, and is moved back if the swap fails. If the app has not
 * exited after 120s, the helper gives up without touching it. Whatever happens after the
 * app exits, the app (new or old) is reopened.
 */
export const INSTALL_SCRIPT = [
  'app_pid="$PPID"',
  "(",
  "  trap '' HUP",
  "  waited=0",
  '  while kill -0 "$app_pid" 2>/dev/null; do',
  '    [ "$waited" -ge 240 ] && exit 1',
  "    sleep 0.5",
  "    waited=$((waited + 1))",
  "  done",
  '  rm -rf "$2.new" "$2.previous"',
  '  if ditto "$1" "$2.new" && mv "$2" "$2.previous"; then',
  '    if mv "$2.new" "$2"; then',
  '      rm -rf "$2.previous" "$4"',
  '      xattr -dr com.apple.quarantine "$2" 2>/dev/null',
  "    else",
  '      mv "$2.previous" "$2"',
  "    fi",
  "  fi",
  '  rm -rf "$2.new"',
  '  [ "$3" = "1" ] && open "$2"',
  ") </dev/null >/dev/null 2>&1 &",
].join("\n");

type Listener = (...args: Array<unknown>) => void;

interface StagedUpdate {
  readonly version: string;
  readonly appPath: string;
  readonly versionDir: string;
}

const isForkUpdateStepError = Schema.is(ForkUpdateStepError);
const stepError = (detail: string, cause?: unknown) => new ForkUpdateStepError({ detail, cause });

/** Keeps a step's own message; anything else (file system, process) gets `detail`. */
const orStepError =
  (detail: string) =>
  (error: unknown): ForkUpdateStepError =>
    isForkUpdateStepError(error) ? error : stepError(detail, error);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ForkReleaseUpdater.make")(function* (repository: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Release download URLs answer with a redirect to GitHub's download CDN.
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronApp = yield* ElectronApp.ElectronApp;
  const appVersion = (yield* electronApp.metadata.pipe(Effect.orDie)).appVersion;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platformKey = `darwin-${yield* HostProcess.Architecture}`;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const updatesDir = path.join(
    environment.T3CODE_HOME?.trim() || path.join(home, ".t3"),
    "runtime",
    "fork-updates",
  );
  // Leftovers of an earlier download or install; a fresh download starts clean anyway.
  yield* fileSystem.remove(updatesDir, { recursive: true, force: true }).pipe(Effect.ignore);

  const listeners = new Map<string, Set<Listener>>();
  const emit = (eventName: string, ...args: Array<unknown>) =>
    Effect.sync(() => {
      for (const listener of listeners.get(eventName) ?? []) listener(...args);
    });

  const channelRef = yield* Ref.make<string | null>(null);
  const pendingRef = yield* Ref.make<ForkUpdate | null>(null);
  const stagedRef = yield* Ref.make<StagedUpdate | null>(null);

  const requestHeaders = { "user-agent": USER_AGENT };
  const request = (url: string) =>
    httpClient.get(url, { headers: requestHeaders }).pipe(
      Effect.mapError((cause) => stepError(`Could not reach ${url}.`, cause)),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(stepError(`Timed out waiting for ${url}.`)),
      }),
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => stepError(describeHttpStatus(url, response.status)),
      ),
    );

  const readChannelFile = Effect.fn("ForkReleaseUpdater.readChannelFile")(function* (
    fileName: string,
  ) {
    const url = channelFileUrl(repository, fileName);
    const response = yield* request(url);
    return yield* response.json.pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(stepError(`Timed out reading ${url}.`)),
      }),
      Effect.mapError(orStepError(`${url} is not valid JSON.`)),
    );
  });

  // A missing or unreadable status counts as "nothing to report".
  const readUpstreamProblem = readChannelFile(UPSTREAM_STATUS_FILE).pipe(
    Effect.flatMap(decodeUpstreamStatus),
    Effect.map((status) => describeUpstreamStatus(repository, status)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const checkForUpdates = Effect.fn("ForkReleaseUpdater.checkForUpdates")(function* () {
    const channel = yield* Ref.get(channelRef);
    const checkError = (detail: string, cause?: unknown) =>
      new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel, detail, cause });
    yield* emit("checking-for-update");
    yield* Ref.set(pendingRef, null);
    const manifest = yield* readChannelFile(LATEST_MANIFEST).pipe(
      Effect.flatMap((json) =>
        decodeManifest(json).pipe(
          Effect.mapError((cause) => stepError(`${LATEST_MANIFEST} is malformed.`, cause)),
        ),
      ),
      Effect.mapError((error) =>
        checkError(`Could not check github.com/${repository} for updates: ${error.detail}`, error),
      ),
    );
    const selection = selectUpdate(manifest, { repository, appVersion, platformKey });
    if (selection._tag === "Invalid") return yield* checkError(selection.reason);
    if (selection._tag === "UpdateAvailable") {
      const { update } = selection;
      yield* Ref.set(pendingRef, update);
      yield* emit("update-available", {
        version: update.version,
        releaseNotes: `Built from ${repository}@${update.commit.slice(0, 12)} (${update.tag}).`,
      });
      return;
    }
    const upstreamProblem = yield* readUpstreamProblem;
    if (Option.isSome(upstreamProblem)) return yield* checkError(upstreamProblem.value);
    yield* emit("update-not-available");
  });

  const run = (command: string, args: ReadonlyArray<string>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(command, args, { stdout: "pipe", stderr: "pipe" }),
        );
        const [stdout, , exitCode] = yield* Effect.all(
          [
            handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
            handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: "unbounded" },
        );
        return { stdout, exitCode: Number(exitCode) };
      }),
    );

  const sha256Of = (filePath: string) =>
    run("/usr/bin/shasum", ["-a", "256", filePath]).pipe(
      Effect.mapError((cause) => stepError("Could not checksum the download.", cause)),
      Effect.flatMap(({ stdout, exitCode }) => {
        const hash = parseShasumOutput(stdout);
        return exitCode === 0 && hash !== null
          ? Effect.succeed(hash)
          : Effect.fail(stepError(`Could not checksum the download (shasum exited ${exitCode}).`));
      }),
    );

  const downloadTo = Effect.fn("ForkReleaseUpdater.downloadTo")(function* (
    asset: ForkUpdate["asset"],
    filePath: string,
  ) {
    const response = yield* request(asset.url);
    const lengthHeader = Number.parseInt(response.headers["content-length"] ?? "", 10);
    const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
    const received = yield* Ref.make(0);
    const lastPercent = yield* Ref.make(-1);
    yield* response.stream.pipe(
      Stream.mapError((cause) => stepError(`The download of ${asset.name} failed.`, cause)),
      Stream.timeoutOrElse({
        duration: DOWNLOAD_IDLE_TIMEOUT,
        orElse: () =>
          Stream.fail(stepError(`The download of ${asset.name} stalled for 60 seconds.`)),
      }),
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          const bytes = yield* Ref.updateAndGet(received, (count) => count + chunk.length);
          if (total === null) return;
          const percent = Math.min(100, Math.floor((bytes / total) * 100));
          if ((yield* Ref.getAndSet(lastPercent, percent)) !== percent) {
            yield* emit("download-progress", { percent });
          }
        }),
      ),
      Stream.run(fileSystem.sink(filePath)),
      Effect.mapError(orStepError(`Could not save ${asset.name}.`)),
    );
    const bytes = yield* Ref.get(received);
    if (total !== null && bytes !== total) {
      return yield* stepError(
        `The download of ${asset.name} ended early (${bytes} of ${total} bytes).`,
      );
    }
  });

  const downloadPending = Effect.gen(function* () {
    const update = yield* Ref.get(pendingRef);
    if (update === null) return yield* stepError("No update is available to download.");
    // Only one download is kept: earlier or half-finished ones go first.
    yield* Ref.set(stagedRef, null);
    yield* fileSystem.remove(updatesDir, { recursive: true, force: true });
    const versionDir = path.join(updatesDir, update.version);
    const zipPath = path.join(versionDir, update.asset.name);
    const stageDir = path.join(versionDir, "stage");
    yield* fileSystem.makeDirectory(stageDir, { recursive: true });

    yield* downloadTo(update.asset, zipPath);
    if ((yield* sha256Of(zipPath)) !== update.asset.sha256) {
      return yield* stepError(
        `${update.asset.name} does not match its SHA-256 in ${LATEST_MANIFEST}.`,
      );
    }

    const unzip = yield* run("/usr/bin/ditto", ["-x", "-k", zipPath, stageDir]).pipe(
      Effect.mapError((cause) => stepError(`Could not unpack ${update.asset.name}.`, cause)),
    );
    const appName = (yield* fileSystem.readDirectory(stageDir)).find((name) =>
      name.endsWith(".app"),
    );
    if (unzip.exitCode !== 0 || appName === undefined) {
      return yield* stepError(`${update.asset.name} holds no app bundle.`);
    }
    yield* fileSystem.remove(zipPath, { force: true }).pipe(Effect.ignore);
    yield* Ref.set(stagedRef, {
      version: update.version,
      appPath: path.join(stageDir, appName),
      versionDir,
    });
    yield* emit("update-downloaded", { version: update.version });
  });

  const downloadUpdate = Effect.fn("ForkReleaseUpdater.downloadUpdate")(function* () {
    const channel = yield* Ref.get(channelRef);
    yield* downloadPending.pipe(
      Effect.mapError(orStepError("Could not prepare the update folder.")),
      Effect.mapError(
        (error) =>
          new ElectronUpdater.ElectronUpdaterDownloadUpdateError({
            channel,
            detail: error.detail,
            cause: error,
          }),
      ),
    );
  });

  const quitAndInstall = Effect.fn("ForkReleaseUpdater.quitAndInstall")(function* ({
    isSilent,
    isForceRunAfter,
  }: {
    readonly isSilent: boolean;
    readonly isForceRunAfter: boolean;
  }) {
    const channel = yield* Ref.get(channelRef);
    const installError = (detail: string, cause?: unknown) =>
      new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
        channel,
        isSilent,
        isForceRunAfter,
        detail,
        cause,
      });
    const update = yield* Ref.get(stagedRef);
    if (update === null) return yield* installError("No downloaded update is ready to install.");
    // .../T3 Code (Nightly).app/Contents/MacOS/<binary>
    const bundlePath = path.resolve(executablePath, "..", "..", "..");
    const blocker = describeInstallBlocker(bundlePath);
    if (blocker !== null) return yield* installError(blocker);
    const parentDir = path.dirname(bundlePath);
    const writable = yield* fileSystem.access(parentDir, { writable: true }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (!writable) {
      return yield* installError(
        `T3 Code cannot replace itself because ${parentDir} is not writable. ` +
          "Move the app to a folder you can write to, or install the update by hand.",
      );
    }
    const stagedExists = yield* fileSystem
      .exists(update.appPath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!stagedExists) {
      return yield* installError("The downloaded update is gone; download it again.");
    }

    yield* Effect.scoped(
      spawner
        .spawn(
          ChildProcess.make(
            "/bin/bash",
            [
              "-c",
              INSTALL_SCRIPT,
              "t3-fork-install",
              update.appPath,
              bundlePath,
              isForceRunAfter ? "1" : "0",
              update.versionDir,
            ],
            // `detached: false` is required: for a detached child (the default on
            // macOS) the spawner's scope finalizer kills the whole process group,
            // which would take the backgrounded installer down with the launcher.
            { stdout: "ignore", stderr: "ignore", detached: false },
          ),
        )
        .pipe(Effect.flatMap((handle) => handle.exitCode)),
    ).pipe(
      Effect.mapError((cause) => installError("Could not start the update installer.", cause)),
    );
    yield* electronApp.quit;
  });

  return ElectronUpdater.ElectronUpdater.of({
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: (next) => Ref.set(channelRef, next),
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: () => Effect.void,
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates: checkForUpdates(),
    downloadUpdate: downloadUpdate(),
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

/** Fork builds update from their fork's `channel` release; every other build uses electron-updater. */
export const layer = Layer.effect(
  ElectronUpdater.ElectronUpdater,
  Effect.gen(function* () {
    const repository = yield* forkReleaseRepository;
    return Option.isSome(repository) ? yield* make(repository.value) : ElectronUpdater.make;
  }),
);
