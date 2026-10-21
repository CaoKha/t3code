import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  channelFileUrl,
  describeHttpStatus,
  describeInstallBlocker,
  describeUpstreamStatus,
  ForkManifest,
  isNewerVersion,
  isSafeVersion,
  isSha256,
  parseShasumOutput,
  resolveForkReleaseRepository,
  selectUpdate,
  UpstreamStatus,
} from "./ForkRelease.ts";

const repository = "me/t3code";
const hash = "a".repeat(64);
const decodeManifest = Schema.decodeUnknownSync(ForkManifest);
const decodeUpstreamStatus = Schema.decodeUnknownSync(UpstreamStatus);

const manifestJson = (version: string, overrides: Record<string, unknown> = {}) => ({
  version,
  tag: `v${version}`,
  commit: "0123456789abcdef0123456789abcdef01234567",
  assets: {
    "darwin-arm64": {
      name: `T3-Code-${version}-arm64.zip`,
      url: `https://github.com/${repository}/releases/download/v${version}/T3-Code-${version}-arm64.zip`,
      sha256: hash,
    },
    "linux-x64": {
      name: `t3-${version}-linux-x64.tar.gz`,
      url: `https://github.com/${repository}/releases/download/v${version}/t3-${version}-linux-x64.tar.gz`,
      sha256: "b".repeat(64),
    },
    ...overrides,
  },
});

const select = (manifest: unknown, appVersion = "0.0.46-nightly.20261015.10009") =>
  selectUpdate(decodeManifest(manifest), {
    repository,
    appVersion,
    platformKey: "darwin-arm64",
  });

describe("isNewerVersion", () => {
  it("orders fork nightlies by date, then run", () => {
    expect(isNewerVersion("0.0.46-nightly.20261016.10010", "0.0.46-nightly.20261015.10009")).toBe(
      true,
    );
    expect(isNewerVersion("0.0.46-nightly.20261015.10009", "0.0.46-nightly.20261016.10010")).toBe(
      false,
    );
    expect(isNewerVersion("0.0.46-nightly.20261015.10010", "0.0.46-nightly.20261015.10009")).toBe(
      true,
    );
  });

  it("orders a fork nightly after the upstream nightly it builds on", () => {
    expect(isNewerVersion("0.0.46-nightly.20261015.10009", "0.0.46-nightly.20261015.3158")).toBe(
      true,
    );
    expect(isNewerVersion("0.0.46-nightly.20261015.3158", "0.0.46-nightly.20261015.10009")).toBe(
      false,
    );
  });

  it("treats the same version as not newer", () => {
    expect(isNewerVersion("0.0.46-nightly.20261015.10009", "0.0.46-nightly.20261015.10009")).toBe(
      false,
    );
  });
});

describe("selectUpdate", () => {
  it("offers a newer build for this platform", () => {
    const selection = select(manifestJson("0.0.46-nightly.20261016.10010"));
    expect(selection._tag).toBe("UpdateAvailable");
    if (selection._tag !== "UpdateAvailable") return;
    expect(selection.update.version).toBe("0.0.46-nightly.20261016.10010");
    expect(selection.update.asset.name).toBe("T3-Code-0.0.46-nightly.20261016.10010-arm64.zip");
    expect(selection.update.asset.sha256).toBe(hash);
  });

  it("is up to date when latest.json is not newer", () => {
    expect(select(manifestJson("0.0.46-nightly.20261015.10009"))._tag).toBe("UpToDate");
    expect(select(manifestJson("0.0.46-nightly.20261014.10001"))._tag).toBe("UpToDate");
  });

  it("rejects versions that are unsafe as paths", () => {
    for (const version of ["../../evil", "1.0.0/../x", "..", "not-a-version"]) {
      expect(select(manifestJson(version))._tag).toBe("Invalid");
    }
  });

  it("rejects a newer build without a valid asset for this platform", () => {
    const version = "0.0.46-nightly.20261016.10010";
    const asset = manifestJson(version).assets["darwin-arm64"];
    const { "darwin-arm64": _darwin, ...withoutDarwin } = manifestJson(version).assets;
    expect(select({ ...manifestJson(version), assets: withoutDarwin })._tag).toBe("Invalid");
    for (const broken of [
      { ...asset, sha256: "not-a-hash" },
      { ...asset, name: "../T3.zip" },
      { ...asset, url: "https://evil.test/T3.zip" },
    ]) {
      expect(select(manifestJson(version, { "darwin-arm64": broken }))._tag).toBe("Invalid");
    }
  });

  it("fails to decode a manifest without assets", () => {
    expect(() => decodeManifest({ version: "1.0.0", tag: "v1.0.0" })).toThrow();
  });
});

describe("validation helpers", () => {
  it("accepts only SHA-256 hex digests", () => {
    expect(isSha256(hash)).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(true);
    expect(isSha256("a".repeat(63))).toBe(false);
    expect(isSha256("g".repeat(64))).toBe(false);
  });

  it("reads shasum output", () => {
    expect(parseShasumOutput(`${hash}  /tmp/T3.zip\n`)).toBe(hash);
    expect(parseShasumOutput("")).toBeNull();
    expect(parseShasumOutput("shasum: /tmp/T3.zip: No such file or directory")).toBeNull();
  });

  it("accepts fork versions as directory names", () => {
    expect(isSafeVersion("0.0.46-nightly.20261015.10009")).toBe(true);
    expect(isSafeVersion(".hidden")).toBe(false);
  });

  it("names the channel download URL", () => {
    expect(channelFileUrl(repository, "latest.json")).toBe(
      "https://github.com/me/t3code/releases/download/channel/latest.json",
    );
  });

  it("explains missing files and rate limits", () => {
    expect(describeHttpStatus("u", 404)).toContain("not found");
    expect(describeHttpStatus("u", 429)).toContain("rate limiting");
    expect(describeHttpStatus("u", 500)).toContain("HTTP 500");
  });
});

describe("describeUpstreamStatus", () => {
  const status = (value: unknown) =>
    describeUpstreamStatus(repository, decodeUpstreamStatus(value));

  it("reports a conflict with its files and the merge command", () => {
    const message = Option.getOrThrow(
      status({ status: "conflict", tag: "v1-nightly.1.1", files: ["a.ts"] }),
    );
    expect(message).toContain("Merge conflict");
    expect(message).toContain("a.ts");
    expect(message).toContain("git merge v1-nightly.1.1");
  });

  it("reports new upstream workflows as needing review", () => {
    const message = Option.getOrThrow(
      status({
        status: "needs-review",
        tag: "v1-nightly.1.1",
        files: [".github/workflows/new.yml"],
      }),
    );
    expect(message).toContain("Needs review");
    expect(message).toContain(".github/workflows/new.yml");
    expect(message).toContain("git merge v1-nightly.1.1");
  });

  it("reports a failed push", () => {
    const message = Option.getOrThrow(
      status({ status: "push-failed", tag: "v1-nightly.1.1", detail: "denied" }),
    );
    expect(message).toContain("could not be pushed");
    expect(message).toContain("denied");
  });

  it("says nothing when in sync or unknown", () => {
    expect(Option.isNone(status({ status: "in-sync", tag: "v1" }))).toBe(true);
    expect(Option.isNone(status({ status: "something-new", tag: "v1" }))).toBe(true);
  });
});

describe("resolveForkReleaseRepository", () => {
  const resolve = (options: Partial<Parameters<typeof resolveForkReleaseRepository>[0]>) =>
    resolveForkReleaseRepository({
      platform: "darwin",
      isPackaged: true,
      runtimeOverride: undefined,
      buildTime: "me/t3code",
      ...options,
    });

  it("uses only the baked-in repository in packaged apps", () => {
    expect(resolve({ runtimeOverride: "other/repo" })).toEqual(Option.some("me/t3code"));
  });

  it("lets unpackaged runs override it", () => {
    expect(resolve({ isPackaged: false, runtimeOverride: "other/repo" })).toEqual(
      Option.some("other/repo"),
    );
  });

  it("is off without a valid repository or outside macOS", () => {
    expect(Option.isNone(resolve({ buildTime: "" }))).toBe(true);
    expect(Option.isNone(resolve({ buildTime: "not a repo" }))).toBe(true);
    expect(Option.isNone(resolve({ platform: "linux" }))).toBe(true);
  });
});

describe("describeInstallBlocker", () => {
  it("refuses translocated and unknown bundles", () => {
    expect(describeInstallBlocker("/Applications/T3 Code (Nightly).app")).toBeNull();
    expect(
      describeInstallBlocker("/private/var/folders/x/AppTranslocation/ABC/d/T3 Code.app"),
    ).toContain("App Translocation");
    expect(describeInstallBlocker("/usr/local/bin")).toContain("Could not locate");
  });
});
