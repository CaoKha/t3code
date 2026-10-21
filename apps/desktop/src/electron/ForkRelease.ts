/**
 * ForkRelease - The pure rules of a fork's release channel, used by ForkReleaseUpdater.
 *
 * A fork's CI (.github/workflows/fork-release.yml) publishes each push as a GitHub
 * release and keeps two files on the fixed `channel` release: `latest.json` (the newest
 * build, with each asset's URL and SHA-256) and `upstream-status.json` (written by
 * fork-upstream-sync.yml).
 *
 * @module ForkRelease
 */
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const LATEST_MANIFEST = "latest.json";
export const UPSTREAM_STATUS_FILE = "upstream-status.json";

/** `latest.json`: the newest build of the fork. */
export const ForkManifest = Schema.Struct({
  version: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
  /** Keyed by `<platform>-<arch>`, e.g. `darwin-arm64` and `linux-x64`. */
  assets: Schema.Record(
    Schema.String,
    Schema.Struct({ name: Schema.String, url: Schema.String, sha256: Schema.String }),
  ),
});
export type ForkManifest = typeof ForkManifest.Type;

/** `upstream-status.json`: the last upstream sync. */
export const UpstreamStatus = Schema.Struct({
  status: Schema.String,
  tag: Schema.String,
  files: Schema.optional(Schema.Array(Schema.String)),
  detail: Schema.optional(Schema.String),
});
export type UpstreamStatus = typeof UpstreamStatus.Type;

export interface ForkUpdate {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  readonly asset: { readonly name: string; readonly url: string; readonly sha256: string };
}

type ManifestSelection =
  | { readonly _tag: "UpdateAvailable"; readonly update: ForkUpdate }
  | { readonly _tag: "UpToDate" }
  | { readonly _tag: "Invalid"; readonly reason: string };

/** Release download URLs are not covered by the GitHub API rate limit. */
export const channelFileUrl = (repository: string, fileName: string) =>
  `https://github.com/${repository}/releases/download/channel/${fileName}`;

/** Safe as a single path segment: no separators, and never `.` or `..`. */
const isSafeFileName = (value: string) => /^\w[\w.-]*$/.test(value);

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

/** What to tell the user about the last upstream sync; nothing when it merged cleanly. */
export function describeUpstreamStatus(
  repository: string,
  status: UpstreamStatus,
): Option.Option<string> {
  const files = status.files ?? [];
  const merge = `\`git fetch upstream --tags && git merge ${status.tag}\``;
  switch (status.status) {
    case "conflict":
      return Option.some(
        `Merge conflict: upstream ${status.tag} conflicts with your changes` +
          `${files.length > 0 ? ` in ${files.join(", ")}` : ""}. ` +
          `Run ${merge} in your clone of ${repository}, ` +
          `resolve the conflicts and push; CI then publishes an update.`,
      );
    case "needs-review":
      return Option.some(
        `Needs review: upstream ${status.tag} adds GitHub workflows` +
          `${files.length > 0 ? ` (${files.join(", ")})` : ""}, so it was not merged automatically. ` +
          `Disable any you do not want under Actions in ${repository}, then run ` +
          `${merge} in your clone and push; CI then publishes an update.`,
      );
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
