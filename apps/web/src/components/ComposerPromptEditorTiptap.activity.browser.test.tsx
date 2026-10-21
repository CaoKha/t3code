import type { Editor } from "@tiptap/core";
import { Activity, createRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

function Composer({ value }: { value: string }) {
  const [prompt, setPrompt] = useState({ value, cursor: value.length });
  return (
    <ComposerPromptEditor
      editorRef={createRef<ComposerPromptEditorHandle>()}
      value={prompt.value}
      cursor={prompt.cursor}
      richTextEnabled
      contextRecords={new Map()}
      skills={[]}
      disabled={false}
      placeholder=""
      onChange={(nextValue, nextCursor) => setPrompt({ value: nextValue, cursor: nextCursor })}
      onPaste={() => {}}
    />
  );
}

// A thread the app keeps mounted while another is on screen sits in a hidden Activity.
const keptThread = (mode: "visible" | "hidden") => (
  <Activity mode={mode}>
    <Composer value="draft prompt" />
  </Activity>
);

function editorIn(container: HTMLElement) {
  return container.querySelector<HTMLElement & { editor: Editor }>(".tiptap")?.editor ?? null;
}

describe("ComposerPromptEditor in a kept thread", () => {
  it("comes back with its prompt after the thread is hidden and shown again", async () => {
    await using screen = await render(keptThread("visible"));
    const first = editorIn(screen.container);
    expect(first).not.toBeNull();

    await screen.rerender(keptThread("hidden"));
    // A hidden editor is torn down, as it would be on unmount.
    await vi.waitFor(() => expect(first?.isDestroyed).toBe(true));
    await screen.rerender(keptThread("visible"));

    await vi.waitFor(() => {
      const shown = editorIn(screen.container);
      expect(shown?.isDestroyed).toBe(false);
      expect(shown?.getText()).toBe("draft prompt");
    });
  });
});
