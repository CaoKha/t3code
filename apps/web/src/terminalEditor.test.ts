import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  registerTerminalEditorRunner,
  runTerminalEditor,
  terminalEditorLaunch,
} from "./terminalEditor";

describe("terminalEditorLaunch", () => {
  it("passes the path through the environment, never the typed command", () => {
    const hostile = "/repo/it's; touch pwned\\'\u0003.ts";
    expect(terminalEditorLaunch("neovim", `${hostile}:12:4`, "darwin")).toEqual({
      command: `nvim '+call cursor(12, 4)' -- "$T3CODE_EDITOR_TARGET"`,
      env: { T3CODE_EDITOR_TARGET: hostile },
    });
    expect(terminalEditorLaunch("neovim", "/repo/a b.ts:12", "linux").command).toBe(
      `nvim '+12' -- "$T3CODE_EDITOR_TARGET"`,
    );
  });

  it("reads the path with PowerShell syntax on Windows", () => {
    expect(terminalEditorLaunch("neovim", "C:\\repo", "windows")).toEqual({
      command: "nvim -- $env:T3CODE_EDITOR_TARGET",
      env: { T3CODE_EDITOR_TARGET: "C:\\repo" },
    });
  });
});

describe("runTerminalEditor", () => {
  const environmentId = EnvironmentId.make("env-1");

  it("reports false without a registered thread and stops routing after unregister", () => {
    expect(runTerminalEditor(environmentId, "neovim", "/repo")).toBe(false);

    const targets: string[] = [];
    const unregister = registerTerminalEditorRunner(({ target }) => {
      targets.push(target);
      return true;
    });
    expect(runTerminalEditor(environmentId, "neovim", "/repo/a.ts:3")).toBe(true);
    unregister();
    expect(runTerminalEditor(environmentId, "neovim", "/repo")).toBe(false);
    expect(targets).toEqual(["/repo/a.ts:3"]);
  });
});
