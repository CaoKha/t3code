import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  registerTerminalEditorRunner,
  runTerminalEditor,
  terminalEditorCommand,
} from "./terminalEditor";

describe("terminalEditorCommand", () => {
  it("opens paths, lines, and columns with shell-safe quoting", () => {
    expect(terminalEditorCommand("neovim", "/repo")).toBe("nvim '/repo'");
    expect(terminalEditorCommand("neovim", "/repo/src/a b.ts:12")).toBe(
      "nvim +12 '/repo/src/a b.ts'",
    );
    expect(terminalEditorCommand("neovim", "/repo/it's.ts:12:4")).toBe(
      "nvim '+call cursor(12, 4)' '/repo/it'\\''s.ts'",
    );
  });
});

describe("runTerminalEditor", () => {
  const environmentId = EnvironmentId.make("env-1");

  it("reports false without a registered thread and stops routing after unregister", () => {
    expect(runTerminalEditor(environmentId, "neovim", "/repo")).toBe(false);

    const commands: string[] = [];
    const unregister = registerTerminalEditorRunner(({ command }) => {
      commands.push(command);
      return true;
    });
    expect(runTerminalEditor(environmentId, "neovim", "/repo/a.ts:3")).toBe(true);
    unregister();
    expect(runTerminalEditor(environmentId, "neovim", "/repo")).toBe(false);
    expect(commands).toEqual(["nvim +3 '/repo/a.ts'"]);
  });
});
