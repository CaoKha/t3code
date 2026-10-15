import { describe, expect, it } from "vite-plus/test";

import {
  checksumFor,
  compareVersions,
  describeConflict,
  desktopZipName,
  selectLatestRelease,
} from "./ForkReleaseUpdater.ts";

const release = (tag_name: string, options: { draft?: boolean; assets?: string[] } = {}) => {
  const version = tag_name.replace(/^v/, "");
  return {
    tag_name,
    draft: options.draft ?? false,
    prerelease: tag_name.includes("-"),
    body: `notes ${version}`,
    assets: (options.assets ?? [desktopZipName(version, "arm64"), "SHA256SUMS"]).map((name) => ({
      name,
      browser_download_url: `https://example.test/${tag_name}/${name}`,
    })),
  };
};

describe("compareVersions", () => {
  it("orders fork nightlies after the upstream nightly they build on", () => {
    expect(
      compareVersions("0.0.46-nightly.20261015.10001", "0.0.46-nightly.20261015.3145"),
    ).toBeGreaterThan(0);
    expect(
      compareVersions("0.0.46-nightly.20261016.10002", "0.0.46-nightly.20261015.10009"),
    ).toBeGreaterThan(0);
  });
});

describe("selectLatestRelease", () => {
  const releases = [
    release("v0.0.46-nightly.20261015.10001"),
    release("v0.0.46-nightly.20261016.10003"),
    release("v0.0.46-nightly.20261017.10004", { draft: true }),
    release("v0.0.46-nightly.20261017.10005", { assets: ["t3-linux-x64.tar.gz"] }),
    release("upstream-status", { assets: [] }),
  ];

  it("picks the newest nightly that ships an app for this arch", () => {
    const latest = selectLatestRelease(releases, "nightly", "arm64");
    expect(latest?.version).toBe("0.0.46-nightly.20261016.10003");
    expect(latest?.asset.name).toBe("T3-Code-0.0.46-nightly.20261016.10003-arm64.zip");
    expect(latest?.checksumsUrl).toContain("SHA256SUMS");
  });

  it("finds nothing for an arch without builds", () => {
    expect(selectLatestRelease(releases, "nightly", "x64")).toBeNull();
  });
});

describe("checksumFor", () => {
  it("reads sha256sum output", () => {
    const hash = "a".repeat(64);
    expect(
      checksumFor(`${hash}  T3-Code-1-arm64.zip\n${"b".repeat(64)}  other`, "T3-Code-1-arm64.zip"),
    ).toBe(hash);
    expect(checksumFor("", "missing")).toBeNull();
  });
});

describe("describeConflict", () => {
  it("names the tag, files and the merge command", () => {
    const message = describeConflict("me/t3code", "v1-nightly.1.1", ["a.ts"]);
    expect(message).toContain("a.ts");
    expect(message).toContain("git merge v1-nightly.1.1");
  });
});
