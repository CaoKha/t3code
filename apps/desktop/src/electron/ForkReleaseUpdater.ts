/**
 * ForkReleaseUpdater - The ElectronUpdater service for builds of a T3 Code fork.
 *
 * A fork's CI (.github/workflows/fork-release.yml) publishes each push as a GitHub
 * release holding the macOS app zip, the Linux CLI archive and SHA256SUMS. Builds made
 * there carry the fork's repository (T3CODE_FORK_RELEASE_REPOSITORY at build time), and
 * this updater, on macOS:
 *
 * - Check: finds the newest fork release on the selected channel with an app for this
 *   arch. When none is newer, it reports the `upstream-status` release (written by
 *   fork-sync-upstream.yml) if upstream could not be merged.
 * - Download: fetches the zip, verifies it against SHA256SUMS and unpacks it.
 * - Install: swaps the running bundle for the new one after the app quits, then relaunches.
 *
 * @module ForkReleaseUpdater
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

declare const __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__: string | undefined;

const GitHubAsset = Schema.Struct({
  name: Schema.String,
  browser_download_url: Schema.String,
});
const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  assets: Schema.Array(GitHubAsset),
});
type GitHubRelease = typeof GitHubRelease.Type;
const decodeReleases = Schema.decodeUnknownEffect(Schema.Array(GitHubRelease));
const decodeRelease = Schema.decodeUnknownEffect(GitHubRelease);

const UpstreamStatus = Schema.Struct({
  status: Schema.String,
  tag: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String)),
});
const decodeUpstreamStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(UpstreamStatus));

export const UPSTREAM_STATUS_TAG = "upstream-status";
const CHECKSUMS_ASSET = "SHA256SUMS";

export interface ForkRelease {
  readonly tag: string;
  readonly version: string;
  readonly notes: string | null;
  readonly asset: { readonly name: string; readonly url: string };
  readonly checksumsUrl: string | null;
}

const versionParts = (version: string) =>
  (version.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));

/** Numeric, field-by-field order: `0.0.46-nightly.20261015.10003` < `0.0.46-nightly.20261016.10004`. */
export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? -1) - (b[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The electron-builder zip name for a version: `T3-Code-<version>-<arch>.zip`. */
export const desktopZipName = (version: string, arch: string) => `T3-Code-${version}-${arch}.zip`;

/** The newest release on a channel that ships an app for `arch`. */
export function selectLatestRelease(
  releases: ReadonlyArray<GitHubRelease>,
  channel: string,
  arch: string,
): ForkRelease | null {
  let latest: ForkRelease | null = null;
  for (const release of releases) {
    if (release.draft) continue;
    const isNightly = release.tag_name.includes("-nightly.");
    if (channel === "nightly" ? !isNightly : isNightly || release.tag_name.includes("-")) {
      continue;
    }
    const version = release.tag_name.replace(/^v/, "");
    const asset = release.assets.find(
      (candidate) => candidate.name === desktopZipName(version, arch),
    );
    if (asset === undefined) continue;
    if (latest !== null && compareVersions(version, latest.version) <= 0) continue;
    latest = {
      tag: release.tag_name,
      version,
      notes: release.body ?? null,
      asset: { name: asset.name, url: asset.browser_download_url },
      checksumsUrl:
        release.assets.find((candidate) => candidate.name === CHECKSUMS_ASSET)
          ?.browser_download_url ?? null,
    };
  }
  return latest;
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

/** The SHA-256 SHA256SUMS lists for `fileName`, if any. */
export function checksumFor(checksums: string, fileName: string): string | null {
  for (const line of checksums.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[2] === fileName) return match[1]!.toLowerCase();
  }
  return null;
}

/** The fork whose releases this build updates from, baked in by the fork's CI. */
export const forkReleaseRepository = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "darwin") return Option.none<string>();
  const environment = yield* HostProcess.Environment;
  const repository =
    environment.T3CODE_FORK_RELEASE_REPOSITORY?.trim() ||
    (typeof __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__ === "undefined"
      ? ""
      : __T3CODE_BUILD_FORK_RELEASE_REPOSITORY__.trim());
  return /^[\w.-]+\/[\w.-]+$/.test(repository) ? Option.some(repository) : Option.none<string>();
});

type Listener = (...args: Array<unknown>) => void;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ForkReleaseUpdater.make")(function* (repository: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const electronApp = yield* ElectronApp.ElectronApp;
  const appVersion = (yield* electronApp.metadata.pipe(Effect.orDie)).appVersion;
  const executablePath = yield* HostProcess.ExecutablePath;
  const arch = yield* HostProcess.Architecture;
  const environment = yield* HostProcess.Environment;
  const home = yield* HostProcess.HomeDirectory;
  const updatesDir = path.join(
    environment.T3CODE_HOME?.trim() || path.join(home, ".t3"),
    "runtime",
    "fork-updates",
  );

  const listeners = new Map<string, Set<Listener>>();
  const emit = (eventName: string, ...args: Array<unknown>) =>
    Effect.sync(() => {
      for (const listener of listeners.get(eventName) ?? []) listener(...args);
    });

  let channel: string | null = null;
  let pending: ForkRelease | null = null;
  let staged: { readonly version: string; readonly appPath: string } | null = null;

  // GitHub's API rejects requests without a User-Agent with HTTP 403.
  const apiHeaders = { accept: "application/vnd.github+json", "user-agent": "t3code-fork" };
  const getJson = (url: string) =>
    httpClient.get(url, { headers: apiHeaders }).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
    );

  // Unknown or unreadable status counts as "nothing to report".
  const readUpstreamConflict = getJson(
    `https://api.github.com/repos/${repository}/releases/tags/${UPSTREAM_STATUS_TAG}`,
  ).pipe(
    Effect.flatMap(decodeRelease),
    Effect.flatMap((release) => decodeUpstreamStatus(release.body ?? "")),
    Effect.map((status) =>
      status.status === "conflict"
        ? Option.some(describeConflict(repository, status.tag, status.files ?? []))
        : Option.none<string>(),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const checkForUpdates = Effect.gen(function* () {
    yield* emit("checking-for-update");
    const releases = yield* getJson(
      `https://api.github.com/repos/${repository}/releases?per_page=30`,
    ).pipe(
      Effect.flatMap(decodeReleases),
      Effect.mapError(
        (cause) =>
          new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
            channel,
            detail: `Could not read releases from github.com/${repository}.`,
            cause,
          }),
      ),
    );
    const latest = selectLatestRelease(releases, channel ?? "latest", arch);
    if (latest !== null && compareVersions(latest.version, appVersion) > 0) {
      pending = latest;
      yield* emit("update-available", { version: latest.version, releaseNotes: latest.notes });
      return;
    }
    pending = null;
    const conflict = yield* readUpstreamConflict;
    if (Option.isSome(conflict)) {
      return yield* new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({
        channel,
        detail: conflict.value,
        cause: conflict.value,
      });
    }
    yield* emit("update-not-available");
  });

  const downloadFailure = (detail: string, cause?: unknown) =>
    new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel, detail, cause });

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

  const downloadTo = (url: string, filePath: string) =>
    Effect.gen(function* () {
      const response = yield* httpClient
        .get(url, { headers: { "user-agent": "t3code-fork" } })
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const total = Number(response.headers["content-length"] ?? 0);
      let received = 0;
      let lastPercent = -1;
      yield* response.stream.pipe(
        Stream.tap((chunk) => {
          received += chunk.length;
          const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
          if (percent === lastPercent) return Effect.void;
          lastPercent = percent;
          return emit("download-progress", { percent });
        }),
        Stream.run(fileSystem.sink(filePath)),
      );
    });

  const downloadUpdate = Effect.gen(function* () {
    const release = pending;
    if (release === null) return yield* downloadFailure("No update is available to download.");
    const versionDir = path.join(updatesDir, release.version);
    const zipPath = path.join(versionDir, release.asset.name);
    const stageDir = path.join(versionDir, "stage");

    yield* fileSystem.remove(versionDir, { recursive: true, force: true });
    yield* fileSystem.makeDirectory(stageDir, { recursive: true });
    yield* downloadTo(release.asset.url, zipPath).pipe(
      Effect.mapError((cause) =>
        downloadFailure(`Could not download ${release.asset.name}.`, cause),
      ),
    );

    if (release.checksumsUrl === null) {
      return yield* downloadFailure(`Release ${release.tag} has no ${CHECKSUMS_ASSET}.`);
    }
    const checksums = yield* httpClient
      .get(release.checksumsUrl, { headers: { "user-agent": "t3code-fork" } })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.mapError((cause) => downloadFailure(`Could not read ${CHECKSUMS_ASSET}.`, cause)),
      );
    const expected = checksumFor(checksums, release.asset.name);
    const actual = yield* run("/usr/bin/shasum", ["-a", "256", zipPath]).pipe(
      Effect.map((result) => result.stdout.split(/\s+/)[0]?.toLowerCase() ?? ""),
      Effect.mapError((cause) => downloadFailure("Could not checksum the download.", cause)),
    );
    if (expected === null || expected !== actual) {
      return yield* downloadFailure(`${release.asset.name} does not match ${CHECKSUMS_ASSET}.`);
    }

    const unzip = yield* run("/usr/bin/ditto", ["-x", "-k", zipPath, stageDir]).pipe(
      Effect.mapError((cause) => downloadFailure(`Could not unpack ${release.asset.name}.`, cause)),
    );
    const appName = (yield* fileSystem
      .readDirectory(stageDir)
      .pipe(Effect.orElseSucceed(() => []))).find((name) => name.endsWith(".app"));
    if (unzip.exitCode !== 0 || appName === undefined) {
      return yield* downloadFailure(`${release.asset.name} holds no app bundle.`);
    }
    yield* fileSystem.remove(zipPath, { force: true }).pipe(Effect.ignore);
    staged = { version: release.version, appPath: path.join(stageDir, appName) };
    yield* emit("update-downloaded", { version: release.version });
  }).pipe(
    Effect.catchTags({
      PlatformError: (cause) =>
        Effect.fail(downloadFailure("Could not prepare the update folder.", cause)),
    }),
  );

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
      if (update === null) return yield* Effect.fail("No downloaded update is ready to install.");
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
                "t3-fork-install",
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
