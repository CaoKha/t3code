import {
  getFiletypeFromFileName,
  type CodeViewScrollTarget,
  type FileDiffMetadata,
} from "@pierre/diffs";
import type { EnvironmentId, ReviewStructuralDiffTarget } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import {
  createContext,
  memo,
  use,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { buildDifftasticRows, toSyntaxLines } from "~/lib/difftasticRows";
import { getDiffLineStat, resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";
import { DifftasticLines, type DifftasticSyntaxLines } from "./DifftasticLines";

interface DifftasticFileStat {
  readonly additions: number;
  readonly deletions: number;
}

export interface DifftasticFile {
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed: boolean;
  /** Overrides the counts read from `fileDiff`, e.g. when it is only a placeholder. */
  readonly stat?: DifftasticFileStat | undefined;
  /** A placeholder whose patch has not arrived: it cannot be expanded yet. */
  readonly unavailable?: boolean | undefined;
}

export type DifftasticFileContextMenuHandler = (filePath: string, event: MouseEvent) => void;

/** Shaped like the standard viewer's handle, so `useCodeViewFileReveal` drives either one. */
export interface DifftasticViewHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

interface DifftasticDiffViewProps {
  readonly environmentId: EnvironmentId;
  readonly files: ReadonlyArray<DifftasticFile>;
  /** Maps a parsed patch file to the old/new pair the server compares; null when unsupported. */
  readonly resolveTarget: (fileDiff: FileDiffMetadata) => ReviewStructuralDiffTarget | null;
  /** Changes whenever the selection's contents may have changed. */
  readonly cacheKey: string;
  readonly layout: "stacked" | "split";
  readonly wordWrap: boolean;
  readonly onToggleCollapsed: (fileKey: string) => void;
  /** Makes the file name open the file; omitted where there is nothing local to open. */
  readonly onOpenFile?: ((filePath: string) => void) | undefined;
  readonly onFileContextMenu?: DifftasticFileContextMenuHandler | undefined;
  /** Receives the handle that scrolls a file into view. */
  readonly viewerRef?: ((handle: DifftasticViewHandle | null) => void) | undefined;
  /** Receives the element that scrolls. */
  readonly containerRef?: ((node: HTMLDivElement | null) => void) | undefined;
  /** Rendered after the last file, inside the scroll container (e.g. a "load more" sentinel). */
  readonly footer?: ReactNode;
}

/** Calls back once an element comes near the scroll container's viewport. */
type ObserveNearViewport = (element: Element, onNear: () => void) => () => void;

const NearViewportContext = createContext<ObserveNearViewport | null>(null);

/** Files this far outside the viewport already run difftastic, so scrolling rarely waits. */
const NEAR_VIEWPORT_MARGIN = "1000px 0px";

function createNearViewportObserver(root: HTMLElement) {
  const callbacks = new Map<Element, () => void>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const onNear = callbacks.get(entry.target);
        callbacks.delete(entry.target);
        observer.unobserve(entry.target);
        onNear?.();
      }
    },
    { root, rootMargin: NEAR_VIEWPORT_MARGIN },
  );
  const observe: ObserveNearViewport = (element, onNear) => {
    callbacks.set(element, onNear);
    observer.observe(element);
    return () => {
      callbacks.delete(element);
      observer.unobserve(element);
    };
  };
  return { observe, disconnect: () => observer.disconnect() };
}

/** Renders each changed file with difftastic's structural diff instead of a line patch. */
export function DifftasticDiffView({
  environmentId,
  files,
  resolveTarget,
  cacheKey,
  layout,
  wordWrap,
  onToggleCollapsed,
  onOpenFile,
  onFileContextMenu,
  viewerRef,
  containerRef,
  footer,
}: DifftasticDiffViewProps) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const setScrollRef = (node: HTMLDivElement | null) => {
    setScrollElement(node);
    containerRef?.(node);
  };
  // Memoized on the element by the compiler; the effect below disconnects each one it replaces.
  const nearViewport =
    scrollElement && typeof IntersectionObserver !== "undefined"
      ? createNearViewportObserver(scrollElement)
      : null;
  useEffect(() => () => nearViewport?.disconnect(), [nearViewport]);

  useEffect(() => {
    if (!viewerRef) return;
    viewerRef({
      getInstance: () => scrollElement ?? undefined,
      scrollTo: (target) => {
        if (!scrollElement || target.type !== "item") return;
        const section = scrollElement.querySelector<HTMLElement>(
          `[data-file-key="${CSS.escape(target.id)}"]`,
        );
        // Scroll only this container: scrollIntoView would also move every scrolling ancestor.
        if (section) scrollElement.scrollTo({ top: section.offsetTop + (target.offset ?? 0) });
      },
    });
    return () => viewerRef(null);
  }, [scrollElement, viewerRef]);

  return (
    <div
      ref={setScrollRef}
      className="difftastic-surface relative h-full min-h-0 overflow-auto bg-code text-code-foreground"
    >
      <NearViewportContext value={nearViewport?.observe ?? null}>
        {files.map((file) => (
          <DifftasticFileSection
            key={file.fileKey}
            environmentId={environmentId}
            fileKey={file.fileKey}
            fileDiff={file.fileDiff}
            collapsed={file.collapsed}
            stat={file.stat}
            unavailable={file.unavailable === true}
            resolveTarget={resolveTarget}
            cacheKey={cacheKey}
            layout={layout}
            wordWrap={wordWrap}
            onToggleCollapsed={onToggleCollapsed}
            onOpenFile={onOpenFile}
            onFileContextMenu={onFileContextMenu}
          />
        ))}
      </NearViewportContext>
      {footer}
    </div>
  );
}

/** Whether the element has come near the viewport; stays true once it has. */
function useNearViewport(ref: { readonly current: Element | null }) {
  const observe = use(NearViewportContext);
  // Without an observer (tests, very old engines) everything renders at once.
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near || !observe || !ref.current) return;
    return observe(ref.current, () => setNear(true));
  }, [near, observe, ref]);
  return near;
}

const DifftasticFileSection = memo(function DifftasticFileSection({
  environmentId,
  fileKey,
  fileDiff,
  collapsed,
  stat: statOverride,
  unavailable,
  resolveTarget,
  cacheKey,
  layout,
  wordWrap,
  onToggleCollapsed,
  onOpenFile,
  onFileContextMenu,
}: {
  readonly environmentId: EnvironmentId;
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed: boolean;
  readonly stat: DifftasticFileStat | undefined;
  readonly unavailable: boolean;
  readonly resolveTarget: (fileDiff: FileDiffMetadata) => ReviewStructuralDiffTarget | null;
  readonly cacheKey: string;
  readonly layout: "stacked" | "split";
  readonly wordWrap: boolean;
  readonly onToggleCollapsed: (fileKey: string) => void;
  readonly onOpenFile: ((filePath: string) => void) | undefined;
  readonly onFileContextMenu: DifftasticFileContextMenuHandler | undefined;
}) {
  const sectionRef = useRef<HTMLElement>(null);
  // The body runs the query, so only files near the viewport ask the server for a diff.
  const near = useNearViewport(sectionRef);
  const filePath = resolveFileDiffPath(fileDiff);
  const target = resolveTarget(fileDiff);
  const stat = statOverride ?? getDiffLineStat([fileDiff]);
  const expanded = !collapsed && !unavailable;
  const displayPath =
    fileDiff.prevName && fileDiff.prevName !== filePath
      ? `${fileDiff.prevName} → ${filePath}`
      : filePath;
  return (
    <section ref={sectionRef} data-file-key={fileKey} className="border-b border-border/70">
      <header
        className="sticky top-0 z-10 flex h-9 items-center gap-1.5 border-b border-border/60 bg-code px-2 font-sans text-xs"
        onContextMenu={(event) => onFileContextMenu?.(filePath, event)}
      >
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={expanded ? `Collapse ${filePath}` : `Expand ${filePath}`}
          aria-expanded={expanded}
          disabled={unavailable}
          onClick={() => onToggleCollapsed(fileKey)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </Button>
        {onOpenFile ? (
          <button
            type="button"
            className="min-w-0 truncate font-mono text-code-foreground hover:underline"
            onClick={() => onOpenFile(filePath)}
          >
            {displayPath}
          </button>
        ) : (
          <span className="min-w-0 truncate font-mono text-code-foreground">{displayPath}</span>
        )}
        <DiffFilePathCopyButton filePath={filePath} />
        <span className="ms-auto shrink-0">
          <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
        </span>
      </header>
      {!expanded ? null : target === null ? (
        <DifftasticNotice>Structural diff is not available for this file.</DifftasticNotice>
      ) : near ? (
        // A new selection starts the file over, folding any gaps the previous one had expanded.
        <DifftasticFileBody
          key={cacheKey}
          environmentId={environmentId}
          target={target}
          filePath={filePath}
          cacheKey={cacheKey}
          layout={layout}
          wordWrap={wordWrap}
        />
      ) : (
        <DifftasticNotice>Running difftastic…</DifftasticNotice>
      )}
    </section>
  );
});

/** Larger files render without syntax colors rather than block on tokenizing. */
const MAX_HIGHLIGHT_CHARS = 200_000;
/** Matches the standard diff's worker pool: longer lines (minified code) render plain. */
const TOKENIZE_MAX_LINE_LENGTH = 1_000;

/**
 * Tokenizes a whole file with the theme the standard diff uses, so multi-line
 * constructs (strings, comments) color correctly. Renders plain until ready.
 */
function useSyntaxLines(contents: string, filePath: string): DifftasticSyntaxLines | null {
  const { resolvedTheme } = useTheme();
  const [highlighted, setHighlighted] = useState<{
    readonly contents: string;
    readonly filePath: string;
    readonly theme: string;
    readonly lines: DifftasticSyntaxLines;
  } | null>(null);
  useEffect(() => {
    if (contents.length === 0 || contents.length > MAX_HIGHLIGHT_CHARS) return;
    let cancelled = false;
    const language = getFiletypeFromFileName(filePath);
    void getSyntaxHighlighterPromise(language)
      .then((highlighter) => {
        if (cancelled) return;
        const { tokens } = highlighter.codeToTokens(contents, {
          lang: highlighter.getLoadedLanguages().includes(language) ? language : "text",
          theme: resolveDiffThemeName(resolvedTheme),
          tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
        });
        setHighlighted({ contents, filePath, theme: resolvedTheme, lines: toSyntaxLines(tokens) });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [contents, filePath, resolvedTheme]);
  // The contents are the query result's own strings, so this is a reference check, not a scan.
  return highlighted?.contents === contents &&
    highlighted.filePath === filePath &&
    highlighted.theme === resolvedTheme
    ? highlighted.lines
    : null;
}

function DifftasticNotice({ children }: { readonly children: ReactNode }) {
  return <p className="px-3 py-2 text-2xs text-muted-foreground">{children}</p>;
}

const DifftasticFileBody = memo(function DifftasticFileBody({
  environmentId,
  target,
  filePath,
  cacheKey,
  layout,
  wordWrap,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ReviewStructuralDiffTarget;
  readonly filePath: string;
  readonly cacheKey: string;
  readonly layout: "stacked" | "split";
  readonly wordWrap: boolean;
}) {
  const query = useEnvironmentQuery(
    reviewEnvironment.structuralDiff({ environmentId, input: { target, cacheKey } }),
  );
  const [expandedGapIds, setExpandedGapIds] = useState<ReadonlySet<number>>(() => new Set());
  const result = query.data;
  // Only a changed result is drawn, so only its contents are worth tokenizing.
  const changed = result?.status === "changed" ? result : null;
  const oldSyntax = useSyntaxLines(changed?.oldContents ?? "", filePath);
  const newSyntax = useSyntaxLines(changed?.newContents ?? "", filePath);
  const rows = changed ? buildDifftasticRows(changed, expandedGapIds) : [];
  const expandGap = (id: number) => setExpandedGapIds((current) => new Set([...current, id]));

  if (!result) {
    return query.error ? (
      <DifftasticNotice>
        <span className="text-error/80">{query.error}</span>
      </DifftasticNotice>
    ) : (
      <DifftasticNotice>Running difftastic…</DifftasticNotice>
    );
  }
  if (result.status === "unavailable") {
    return (
      <DifftasticNotice>
        {result.reason ?? "difftastic could not compare this file."}
      </DifftasticNotice>
    );
  }
  if (rows.length === 0) {
    return <DifftasticNotice>No structural changes. Only formatting differs.</DifftasticNotice>;
  }

  return (
    <div
      className={cn(
        "font-mono text-(length:--font-size-code) leading-5",
        !wordWrap && "overflow-x-auto",
      )}
    >
      {result.language ? (
        <div className="px-3 pt-1 text-2xs text-muted-foreground/70">{result.language}</div>
      ) : null}
      <DifftasticLines
        rows={rows}
        layout={layout}
        wordWrap={wordWrap}
        syntax={{ old: oldSyntax, new: newSyntax }}
        onExpandGap={expandGap}
      />
    </div>
  );
});
