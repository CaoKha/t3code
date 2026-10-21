import type { FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestReviewGuide } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { orderDiffFiles, orderDiffFilesByGuide } from "./pullRequestFileOrder.logic";

function file(name: string, additionLines: ReadonlyArray<string> = []): FileDiffMetadata {
  return { name, hunks: [], additionLines, deletionLines: [] } as unknown as FileDiffMetadata;
}

function order(files: ReadonlyArray<FileDiffMetadata>): Array<string> {
  return orderDiffFiles(files).map((entry) => entry.name);
}

describe("orderDiffFiles", () => {
  it("places source before tests and generated files across path conventions", () => {
    const source = ["src/app.ts", "src/dist.ts", "src/testing.ts"];
    const tests = [
      "src/__tests__/app.ts",
      "src/app.spec.tsx",
      "src/app.test.ts",
      "test/app.ts",
      "tests/helpers/app.ts",
    ];
    const generated = [
      "apps/web/package-lock.json",
      "dist/app.js",
      "packages/core/vendor/lib.js",
      "pnpm-lock.yaml",
      "public/app.min.js",
      "src/__snapshots__/app.ts",
      "src/api.generated.ts",
      "src/app.test.ts.snap",
    ];
    expect(
      order([...generated, ...tests, ...source].toReversed().map((path) => file(path))),
    ).toEqual([...source, ...tests, ...generated]);
  });

  it("resolves a specifier that climbs out of the importer's directory", () => {
    expect(
      order([file("src/ui/a.ts", ['import { b } from "../lib/b";']), file("src/lib/b.ts")]),
    ).toEqual(["src/lib/b.ts", "src/ui/a.ts"]);
  });

  it("resolves a directory specifier to that directory's index file", () => {
    expect(
      order([file("src/a.ts", ['import { b } from "./lib";']), file("src/lib/index.ts")]),
    ).toEqual(["src/lib/index.ts", "src/a.ts"]);
  });

  it("falls back to the specifier's last segment when the path does not line up", () => {
    expect(order([file("src/a.ts", ['import { b } from "~/lib/b";']), file("lib/b.ts")])).toEqual([
      "lib/b.ts",
      "src/a.ts",
    ]);
  });

  it("ignores an ambiguous last segment rather than guessing", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "~/somewhere/b";']),
        file("one/b.ts"),
        file("two/b.ts"),
      ]),
    ).toEqual(["one/b.ts", "src/a.ts", "two/b.ts"]);
  });

  it("resolves a specifier naming an extension, including the .js beside a .ts", () => {
    expect(order([file("src/a.ts", ['import { b } from "./b.js";']), file("src/b.ts")])).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("reads require and bare imports too", () => {
    expect(
      order([
        file("src/a.ts", ['const b = require("./b");', 'import "./c";']),
        file("src/b.ts"),
        file("src/c.ts"),
      ]),
    ).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
  });

  it("falls back to path order inside a cycle", () => {
    expect(
      order([
        file("src/b.ts", ['import { a } from "./a";']),
        file("src/a.ts", ['import { b } from "./b";']),
      ]),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("keeps the tiers apart and orders tests by the source they cover", () => {
    expect(
      order([
        file("pnpm-lock.yaml"),
        file("src/a.test.ts"),
        file("src/__tests__/b.ts"),
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts"),
        file("dist/a.js"),
      ]),
    ).toEqual([
      "src/b.ts",
      "src/a.ts",
      "src/__tests__/b.ts",
      "src/a.test.ts",
      "dist/a.js",
      "pnpm-lock.yaml",
    ]);
  });

  it("puts a test with no source in the diff after the ones that have theirs", () => {
    expect(order([file("src/orphan.spec.ts"), file("src/a.test.ts"), file("src/a.ts")])).toEqual([
      "src/a.ts",
      "src/a.test.ts",
      "src/orphan.spec.ts",
    ]);
  });

  it("orders the same diff the same way whatever order it arrives in", () => {
    const files = [
      file("src/a.ts", ['import { b } from "./b";']),
      file("src/b.ts"),
      file("src/c.ts"),
      file("src/a.test.ts"),
      file("yarn.lock"),
    ];
    expect(order(files)).toEqual(order(files.toReversed()));
  });
});

/** A guide whose stops excerpt the first paths of each entry and list the rest. */
function guide(
  stops: ReadonlyArray<{ excerpts?: ReadonlyArray<string>; files?: ReadonlyArray<string> }>,
): PullRequestReviewGuide {
  return {
    stops: stops.map((stop) => ({
      excerpts: (stop.excerpts ?? []).map((path) => ({ path })),
      files: (stop.files ?? []).map((path) => ({ path })),
    })),
  } as unknown as PullRequestReviewGuide;
}

describe("orderDiffFilesByGuide", () => {
  it("follows the tour, placing each file at the first stop that names it", () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"].map((path) => file(path));
    expect(
      orderDiffFilesByGuide(
        files,
        guide([
          { excerpts: ["src/c.ts", "src/a.ts"] },
          { excerpts: ["src/c.ts"], files: ["src/d.ts"] },
          { files: ["src/b.ts", "src/a.ts"] },
        ]),
      ).map((entry) => entry.name),
    ).toEqual(["src/c.ts", "src/a.ts", "src/d.ts", "src/b.ts"]);
  });

  it("keeps files the guide never names after it, in the default order", () => {
    const files = [
      file("src/a.test.ts"),
      file("src/a.ts", ['import { b } from "./b";']),
      file("src/b.ts"),
      file("src/z.ts"),
    ];
    expect(
      orderDiffFilesByGuide(files, guide([{ excerpts: ["src/z.ts", "src/gone.ts"] }])).map(
        (entry) => entry.name,
      ),
    ).toEqual(["src/z.ts", "src/b.ts", "src/a.ts", "src/a.test.ts"]);
  });
});
