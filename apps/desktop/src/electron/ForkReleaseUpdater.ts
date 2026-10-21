/**
 * ForkReleaseUpdater - The ElectronUpdater service for builds of a T3 Code fork.
 *
 * Builds made by a fork's CI carry the fork's repository (T3CODE_FORK_RELEASE_REPOSITORY
 * at build time), and this updater, on macOS:
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
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
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

import { resolveDesktopBaseDir } from "../app/DesktopStatePaths.ts";
import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";
import {
  channelFileUrl,
  describeHttpStatus,
  describeInstallBlocker,
  describeUpstreamStatus,
  ForkManifest,
  type ForkUpdate,
  LATEST_MANIFEST,
  parseShasumOutput,
  resolveForkReleaseRepository,
  selectUpdate,
  UPSTREAM_STATUS_FILE,
  UpstreamStatus,
} from "./ForkRelease.ts";

declare const __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__: string | undefined;

const USER_AGENT = "t3code-fork-updater";
const REQUEST_TIMEOUT = Duration.seconds(20);
/** A download that delivers no bytes for this long has stalled. */
const DOWNLOAD_IDLE_TIMEOUT = Duration.seconds(60);

const decodeManifest = Schema.decodeUnknownEffect(ForkManifest);
const decodeUpstreamStatus = Schema.decodeUnknownEffect(UpstreamStatus);

/** A step of a check or download that failed, with a message written for the user. */
class ForkUpdateStepError extends Schema.TaggedError<ForkUpdateStepError>()("ForkUpdateStepError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const isForkUpdateStepError = Schema.is(ForkUpdateStepError);

/** Keeps a step's own message; anything else (file system, process) gets `detail`. */
const orStepError =
  (detail: string) =>
  (error: unknown): ForkUpdateStepError =>
    isForkUpdateStepError(error) ? error : new ForkUpdateStepError({ detail, cause: error });

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

const forkReleaseRepository = Effect.gen(function* () {
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

const make = Effect.fn("ForkReleaseUpdater.make")(function* (repository: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Release download URLs answer with a redirect to GitHub's download CDN.
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects(5));
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronApp = yield* ElectronApp.ElectronApp;
  const appVersion = (yield* electronApp.metadata.pipe(Effect.orDie)).appVersion;
  const executablePath = yield* HostProcess.ExecutablePath;
  const platformKey = `darwin-${yield* HostProcess.Architecture}`;
  const updatesDir = path.join(
    resolveDesktopBaseDir({
      homeDirectory: yield* HostProcess.HomeDirectory,
      joinPath: path.join,
      t3Home: Option.fromUndefinedOr((yield* HostProcess.Environment).T3CODE_HOME),
    }),
    "runtime",
    "fork-updates",
  );
  // Best effort: removing an unpacked .app can fail with ENOTEMPTY on macOS (e.g. while
  // Spotlight or LaunchServices reads it); each download gets a fresh folder, so a
  // leftover never blocks one.
  const removeQuietly = (target: string) =>
    fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);
  // Leftovers of an earlier download or install.
  yield* removeQuietly(updatesDir);

  const listeners = new Map<string, Set<Listener>>();
  const emit = (eventName: string, ...args: Array<unknown>) =>
    Effect.sync(() => {
      for (const listener of listeners.get(eventName) ?? []) listener(...args);
    });

  const channelRef = yield* Ref.make<string | null>(null);
  const pendingRef = yield* Ref.make<ForkUpdate | null>(null);
  const stagedRef = yield* Ref.make<StagedUpdate | null>(null);

  const request = (url: string) =>
    httpClient.get(url, { headers: { "user-agent": USER_AGENT } }).pipe(
      Effect.mapError(
        (cause) => new ForkUpdateStepError({ detail: `Could not reach ${url}.`, cause }),
      ),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(new ForkUpdateStepError({ detail: `Timed out waiting for ${url}.` })),
      }),
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => new ForkUpdateStepError({ detail: describeHttpStatus(url, response.status) }),
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
        orElse: () => Effect.fail(new ForkUpdateStepError({ detail: `Timed out reading ${url}.` })),
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
          Effect.mapError(
            (cause) =>
              new ForkUpdateStepError({ detail: `${LATEST_MANIFEST} is malformed.`, cause }),
          ),
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

  const run = Effect.fn("ForkReleaseUpdater.run")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
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
  }, Effect.scoped);

  const sha256Of = Effect.fn("ForkReleaseUpdater.sha256Of")(function* (filePath: string) {
    const { stdout, exitCode } = yield* run("/usr/bin/shasum", ["-a", "256", filePath]).pipe(
      Effect.mapError(
        (cause) => new ForkUpdateStepError({ detail: "Could not checksum the download.", cause }),
      ),
    );
    const hash = parseShasumOutput(stdout);
    if (exitCode !== 0 || hash === null) {
      return yield* new ForkUpdateStepError({
        detail: `Could not checksum the download (shasum exited ${exitCode}).`,
      });
    }
    return hash;
  });

  const downloadTo = Effect.fn("ForkReleaseUpdater.downloadTo")(function* (
    asset: ForkUpdate["asset"],
    filePath: string,
  ) {
    const response = yield* request(asset.url);
    const lengthHeader = Number.parseInt(response.headers["content-length"] ?? "", 10);
    const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
    let received = 0;
    let lastPercent = -1;
    yield* response.stream.pipe(
      Stream.mapError(
        (cause) =>
          new ForkUpdateStepError({ detail: `The download of ${asset.name} failed.`, cause }),
      ),
      Stream.timeoutOrElse({
        duration: DOWNLOAD_IDLE_TIMEOUT,
        orElse: () =>
          Stream.fail(
            new ForkUpdateStepError({
              detail: `The download of ${asset.name} stalled for 60 seconds.`,
            }),
          ),
      }),
      Stream.tap((chunk) => {
        received += chunk.length;
        if (total === null) return Effect.void;
        const percent = Math.min(100, Math.floor((received / total) * 100));
        if (percent === lastPercent) return Effect.void;
        lastPercent = percent;
        return emit("download-progress", { percent });
      }),
      Stream.run(fileSystem.sink(filePath)),
      Effect.mapError(orStepError(`Could not save ${asset.name}.`)),
    );
    if (total !== null && received !== total) {
      return yield* new ForkUpdateStepError({
        detail: `The download of ${asset.name} ended early (${received} of ${total} bytes).`,
      });
    }
  });

  /** Downloads, verifies and unpacks `update` into `versionDir`; returns the staged app. */
  const stageUpdate = Effect.fn("ForkReleaseUpdater.stageUpdate")(function* (
    update: ForkUpdate,
    versionDir: string,
  ) {
    const zipPath = path.join(versionDir, update.asset.name);
    const stageDir = path.join(versionDir, "stage");
    yield* fileSystem.makeDirectory(stageDir, { recursive: true });

    yield* downloadTo(update.asset, zipPath);
    if ((yield* sha256Of(zipPath)) !== update.asset.sha256) {
      return yield* new ForkUpdateStepError({
        detail: `${update.asset.name} does not match its SHA-256 in ${LATEST_MANIFEST}.`,
      });
    }

    const unzip = yield* run("/usr/bin/ditto", ["-x", "-k", zipPath, stageDir]).pipe(
      Effect.mapError(
        (cause) =>
          new ForkUpdateStepError({ detail: `Could not unpack ${update.asset.name}.`, cause }),
      ),
    );
    const appName = (yield* fileSystem.readDirectory(stageDir)).find((name) =>
      name.endsWith(".app"),
    );
    if (unzip.exitCode !== 0 || appName === undefined) {
      return yield* new ForkUpdateStepError({
        detail: `${update.asset.name} holds no app bundle.`,
      });
    }
    yield* removeQuietly(zipPath);
    return path.join(stageDir, appName);
  });

  const downloadPending = Effect.gen(function* () {
    const update = yield* Ref.get(pendingRef);
    if (update === null) {
      return yield* new ForkUpdateStepError({ detail: "No update is available to download." });
    }
    // Only one download is kept: earlier or half-finished ones go first.
    yield* Ref.set(stagedRef, null);
    yield* removeQuietly(updatesDir);
    const versionDir = path.join(updatesDir, `${update.version}-${yield* Clock.currentTimeMillis}`);
    // A failed download would otherwise keep its partial zip until the next launch.
    const appPath = yield* stageUpdate(update, versionDir).pipe(
      Effect.onError(() => removeQuietly(versionDir)),
    );
    yield* Ref.set(stagedRef, { version: update.version, appPath, versionDir });
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
