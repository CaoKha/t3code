import {
  EDITORS,
  type EditorId,
  type EnvironmentId,
  type ExecutionEnvironmentPlatformOs,
} from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import * as Schema from "effect/Schema";

/**
 * Terminal editors (Neovim) open in a new terminal in the visible thread's side panel.
 * ChatView registers the runner that owns that thread's terminals; every
 * open-in-editor path routes terminal editors here instead of the server.
 */
type TerminalEditorRunner = (input: {
  readonly environmentId: EnvironmentId;
  readonly editor: EditorId;
  readonly target: string;
}) => boolean;

let activeRunner: TerminalEditorRunner | null = null;

export function registerTerminalEditorRunner(runner: TerminalEditorRunner): () => void {
  activeRunner = runner;
  return () => {
    if (activeRunner === runner) activeRunner = null;
  };
}

export class TerminalEditorUnavailableError extends Schema.TaggedError<TerminalEditorUnavailableError>()(
  "TerminalEditorUnavailableError",
  { targetPath: Schema.String },
) {
  override get message(): string {
    return `Open a thread to edit ${this.targetPath} in its terminal.`;
  }
}

const TARGET_ENV = "T3CODE_EDITOR_TARGET";

export interface TerminalEditorLaunch {
  /** Typed into the new terminal's shell. */
  readonly command: string;
  /** Environment the new terminal starts with. */
  readonly env: Record<string, string>;
}

/**
 * Opens `target` (`path[:line[:column]]`) in a terminal editor. The path rides in the
 * terminal's environment rather than the typed line: no single quoting is safe across
 * sh, fish, and PowerShell, and control characters in a filename would reach the tty.
 */
export function terminalEditorLaunch(
  editor: EditorId,
  target: string,
  os: ExecutionEnvironmentPlatformOs | undefined,
): TerminalEditorLaunch {
  const program = EDITORS.find((candidate) => candidate.id === editor)?.commands?.[0] ?? editor;
  const { path, line, column } = splitFilePathPosition(target);
  // Quoted so PowerShell keeps `+12` a string; these single quotes are literal in every shell.
  const position =
    line === undefined
      ? []
      : [column === undefined ? `'+${line}'` : `'+call cursor(${line}, ${column})'`];
  const pathArgument = os === "windows" ? `$env:${TARGET_ENV}` : `"$${TARGET_ENV}"`;
  return {
    command: [program, ...position, "--", pathArgument].join(" "),
    env: { [TARGET_ENV]: path },
  };
}

/** Returns false when no thread is mounted to host the terminal. */
export function runTerminalEditor(
  environmentId: EnvironmentId,
  editor: EditorId,
  target: string,
): boolean {
  return activeRunner?.({ environmentId, editor, target }) ?? false;
}
