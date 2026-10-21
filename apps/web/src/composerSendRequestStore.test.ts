import { describe, expect, it } from "vite-plus/test";

import { useComposerSendRequestStore } from "./composerSendRequestStore";

describe("useComposerSendRequestStore", () => {
  it("hands a request to its composer once", () => {
    const store = useComposerSendRequestStore.getState();
    store.request("env:thread-a");

    expect(store.consume("env:thread-b")).toBe(false);
    expect(store.consume("env:thread-a")).toBe(true);
    expect(store.consume("env:thread-a")).toBe(false);
  });

  it("keeps other composers' requests when one is taken", () => {
    const store = useComposerSendRequestStore.getState();
    store.request("draft-1");
    store.request("draft-2");

    store.consume("draft-1");

    expect(useComposerSendRequestStore.getState().pending.has("draft-2")).toBe(true);
    store.consume("draft-2");
  });
});
