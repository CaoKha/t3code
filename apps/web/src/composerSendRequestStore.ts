import { create } from "zustand";

interface ComposerSendRequestStoreState {
  /** Composer target keys asked to send what was just written into them. */
  readonly pending: ReadonlySet<string>;
  readonly request: (targetKey: string) => void;
  /** Takes the request for this composer, if there is one. */
  readonly consume: (targetKey: string) => boolean;
}

/**
 * Lets a feature outside the composer send a message it wrote into the draft, through the
 * composer's own send path. A composer not on screen sends once it is.
 */
export const useComposerSendRequestStore = create<ComposerSendRequestStoreState>()((set, get) => ({
  pending: new Set(),
  request: (targetKey) => set({ pending: new Set([...get().pending, targetKey]) }),
  consume: (targetKey) => {
    const { pending } = get();
    if (!pending.has(targetKey)) return false;
    set({ pending: new Set([...pending].filter((key) => key !== targetKey)) });
    return true;
  },
}));
