import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./query";

describe("formatEnvironmentQueryError", () => {
  it("explains methods an older server does not know", () => {
    const message = formatEnvironmentQueryError(
      Cause.die({ message: "Unknown request tag: review.getStructuralDiff" }),
    );
    expect(message).toContain("does not support review.getStructuralDiff");
  });

  it("keeps error messages and falls back for empty causes", () => {
    expect(formatEnvironmentQueryError(Cause.fail(new Error("boom")))).toBe("boom");
    expect(formatEnvironmentQueryError(Cause.die(42))).toBe("The environment request failed.");
  });
});
