import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./query";

describe("formatEnvironmentQueryError", () => {
  it("explains methods an older server does not know", () => {
    // RpcServer dies with this string; Schema.Defect keeps strings as strings.
    expect(
      formatEnvironmentQueryError(Cause.die("Unknown request tag: review.getStructuralDiff")),
    ).toContain("does not support review.getStructuralDiff");
    expect(
      formatEnvironmentQueryError(Cause.die(new Error("Unknown request tag: git.status"))),
    ).toContain("does not support git.status");
  });

  it("keeps error messages and falls back for other causes", () => {
    expect(formatEnvironmentQueryError(Cause.fail(new Error("boom")))).toBe("boom");
    expect(formatEnvironmentQueryError(Cause.die("internal detail"))).toBe(
      "The environment request failed.",
    );
    expect(formatEnvironmentQueryError(Cause.die(42))).toBe("The environment request failed.");
  });
});
