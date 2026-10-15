import { describe, expect, it } from "vite-plus/test";

import {
  compareVersions,
  describeConflict,
  parseUpdateScriptLine,
  selectLatestRelease,
} from "./SourceBuildUpdater.ts";

const release = (tag_name: string, prerelease = false, draft = false) => ({
  tag_name,
  prerelease,
  draft,
  body: null,
});

describe("compareVersions", () => {
  it("orders nightly builds by date and build number", () => {
    expect(
      compareVersions("0.0.46-nightly.20261016.1", "0.0.46-nightly.20261015.3145"),
    ).toBeGreaterThan(0);
    expect(compareVersions("0.0.46-nightly.20261015.3145", "0.0.46-nightly.20261015.3145")).toBe(0);
    expect(compareVersions("0.0.45", "0.0.46")).toBeLessThan(0);
  });
});

describe("selectLatestRelease", () => {
  const releases = [
    release("v0.0.46-nightly.20261015.3145", true),
    release("v0.0.46-nightly.20261016.3160", true),
    release("v0.0.47-nightly.20261020.1", true, true),
    release("v0.0.46-preview.20261008.2802", true),
    release("v0.0.45"),
  ];

  it("follows nightly tags on the nightly channel and skips drafts", () => {
    expect(selectLatestRelease(releases, "nightly")?.version).toBe("0.0.46-nightly.20261016.3160");
  });

  it("follows stable releases on the latest channel", () => {
    expect(selectLatestRelease(releases, "latest")?.tag).toBe("v0.0.45");
  });
});

describe("parseUpdateScriptLine", () => {
  it("parses markers and ignores other output", () => {
    expect(parseUpdateScriptLine("PROGRESS 55")).toEqual({ _tag: "progress", percent: 55 });
    expect(parseUpdateScriptLine("CONFLICT apps/web/src/a b.ts")).toEqual({
      _tag: "conflict",
      file: "apps/web/src/a b.ts",
    });
    expect(parseUpdateScriptLine("STAGED_APP /tmp/T3 Code (Nightly).app")).toEqual({
      _tag: "staged",
      appPath: "/tmp/T3 Code (Nightly).app",
    });
    expect(parseUpdateScriptLine("Already up to date.")).toBeNull();
  });
});

describe("describeConflict", () => {
  it("names the files and how to resolve them", () => {
    const message = describeConflict("v1", "/repo", ["a.ts", "b.ts"]);
    expect(message).toContain("a.ts, b.ts");
    expect(message).toContain("git merge v1");
  });
});
