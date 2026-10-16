import { EDITORS, type EditorId, type EnvironmentId } from "@t3tools/contracts";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import * as Schema from "effect/Schema";

/**
 * Terminal editors (Neovim) open in a new terminal in the visible thread's side panel.
 * ChatView registers the runner that owns that thread's terminals; every
 * open-in-editor path routes terminal editors here instead of the server.
 */
type TerminalEditorRunner = (input: {
  readonly environmentId: EnvironmentId;
  readonly command: string;
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

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Shell command that opens `target` (`path[:line[:column]]`) in a terminal editor. */
export function terminalEditorCommand(editor: EditorId, target: string): string {
  const program = EDITORS.find((candidate) => candidate.id === editor)?.commands?.[0] ?? editor;
  const { path, line, column } = splitFilePathPosition(target);
  const position =
    line === undefined
      ? []
      : column === undefined
        ? [`+${line}`]
        : [quotePosix(`+call cursor(${line}, ${column})`)];
  return [program, ...position, quotePosix(path)].join(" ");
}

/** Returns false when no thread is mounted to host the terminal. */
export function runTerminalEditor(
  environmentId: EnvironmentId,
  editor: EditorId,
  target: string,
): boolean {
  return activeRunner?.({ environmentId, command: terminalEditorCommand(editor, target) }) ?? false;
}
