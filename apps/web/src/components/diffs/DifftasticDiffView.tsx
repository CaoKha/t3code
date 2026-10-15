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
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import {
  buildDifftasticRows,
  segmentLine,
  stackDifftasticRows,
  toSyntaxLines,
  type DifftasticSegment,
  type DifftasticSyntaxToken,
  type DifftasticGapRow,
  type DifftasticLineRow,
  type DifftasticRow,
  type DifftasticSide,
} from "~/lib/difftasticRows";
import { getDiffLineStat, resolveDiffThemeName, resolveFileDiffPath } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";
import { useTheme } from "~/hooks/useTheme";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";

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
  const setScrollRef = useCallback(
    (node: HTMLDivElement | null) => {
      setScrollElement(node);
      containerRef?.(node);
    },
    [containerRef],
  );
  const nearViewport = useMemo(
    () =>
      scrollElement && typeof IntersectionObserver !== "undefined"
        ? createNearViewportObserver(scrollElement)
        : null,
    [scrollElement],
  );
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
    <div ref={setScrollRef} className="difftastic-surface relative h-full min-h-0 overflow-auto">
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
  const target = useMemo(() => resolveTarget(fileDiff), [fileDiff, resolveTarget]);
  const stat = useMemo(() => statOverride ?? getDiffLineStat([fileDiff]), [fileDiff, statOverride]);
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

type SyntaxLines = ReadonlyArray<ReadonlyArray<DifftasticSyntaxToken>>;

const SyntaxContext = createContext<{
  readonly old: SyntaxLines | null;
  readonly new: SyntaxLines | null;
}>({ old: null, new: null });

/**
 * Tokenizes a whole file with the theme the standard diff uses, so multi-line
 * constructs (strings, comments) color correctly. Renders plain until ready.
 */
function useSyntaxLines(contents: string, filePath: string): SyntaxLines | null {
  const { resolvedTheme } = useTheme();
  const [highlighted, setHighlighted] = useState<{
    readonly contents: string;
    readonly filePath: string;
    readonly theme: string;
    readonly lines: SyntaxLines;
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
  cacheKey,
  layout,
  wordWrap,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ReviewStructuralDiffTarget;
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
  const filePath = target._tag === "turn" ? target.newPath : target.file.newPath;
  const oldSyntax = useSyntaxLines(changed?.oldContents ?? "", filePath);
  const newSyntax = useSyntaxLines(changed?.newContents ?? "", filePath);
  const syntax = useMemo(() => ({ old: oldSyntax, new: newSyntax }), [newSyntax, oldSyntax]);
  const rows = useMemo(
    () => (changed ? buildDifftasticRows(changed, expandedGapIds) : []),
    [changed, expandedGapIds],
  );
  const expandGap = useCallback(
    (id: number) => setExpandedGapIds((current) => new Set([...current, id])),
    [],
  );

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
  if (result.status === "unchanged" || rows.length === 0) {
    return <DifftasticNotice>No structural changes. Only formatting differs.</DifftasticNotice>;
  }

  return (
    <div className={cn("difftastic-code font-mono leading-5", !wordWrap && "overflow-x-auto")}>
      {result.language ? (
        <div className="px-3 pt-1 text-2xs text-muted-foreground/70">{result.language}</div>
      ) : null}
      <SyntaxContext value={syntax}>
        {layout === "split" ? (
          <SplitRows rows={rows} wordWrap={wordWrap} onExpandGap={expandGap} />
        ) : (
          <StackedRows rows={rows} wordWrap={wordWrap} onExpandGap={expandGap} />
        )}
      </SyntaxContext>
    </div>
  );
});

const GapRow = memo(function GapRow({
  row,
  className,
  onExpandGap,
}: {
  readonly row: DifftasticGapRow;
  readonly className?: string;
  readonly onExpandGap: (id: number) => void;
}) {
  return (
    <button
      type="button"
      data-dt-gap
      className={cn(
        "block w-full px-3 py-0.5 text-start font-sans text-2xs text-muted-foreground",
        className,
      )}
      onClick={() => onExpandGap(row.id)}
    >
      ⋯ {row.hiddenCount} unchanged {row.hiddenCount === 1 ? "line" : "lines"}
    </button>
  );
});

const LINE_NUMBER_CLASS =
  "w-12 shrink-0 select-none pe-2 text-end tabular-nums text-muted-foreground/50";

const lineTextClass = (wordWrap: boolean) =>
  wordWrap ? "wrap-anywhere whitespace-pre-wrap" : "whitespace-pre";

function segmentStyle(segment: Pick<DifftasticSegment, "color" | "fontStyle">) {
  const fontStyle = segment.fontStyle ?? 0;
  return {
    ...(segment.color ? { color: segment.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  } as const;
}

function LineText({ side, tone }: { readonly side: DifftasticSide; readonly tone: "old" | "new" }) {
  const syntaxLine = use(SyntaxContext)[tone]?.[side.lineNumber];
  const segments = useMemo(
    () => segmentLine(side.text, side.changes, syntaxLine),
    [side, syntaxLine],
  );
  return segments.map((segment) => (
    <span
      key={segment.start}
      style={segmentStyle(segment)}
      // Changed tokens keep their syntax color and gain the diff emphasis, like the standard view.
      {...(segment.novel
        ? { "data-dt-novel": tone === "old" ? "deletion" : "addition", className: "rounded-xs" }
        : {})}
    >
      {segment.text}
    </span>
  ));
}

function SplitCell({
  side,
  tone,
  changed,
  wordWrap,
}: {
  readonly side: DifftasticSide | null;
  readonly tone: "old" | "new";
  readonly changed: boolean;
  readonly wordWrap: boolean;
}) {
  const divider = tone === "old" && "border-e border-border/40";
  if (side === null) {
    return <div data-dt-empty className={cn("min-w-0", divider)} />;
  }
  const novel = changed && (side.changes.length > 0 || side.text.length === 0);
  return (
    <div
      className={cn("flex min-w-0", divider)}
      {...(novel ? { "data-dt-line": tone === "old" ? "deletion" : "addition" } : {})}
    >
      <span data-dt-gutter className={LINE_NUMBER_CLASS}>
        {side.lineNumber + 1}
      </span>
      <span className={cn("min-w-0 flex-1 pe-2", lineTextClass(wordWrap))}>
        <LineText side={side} tone={tone} />
      </span>
    </div>
  );
}

const SplitRow = memo(function SplitRow({
  row,
  wordWrap,
}: {
  readonly row: DifftasticLineRow;
  readonly wordWrap: boolean;
}) {
  return (
    <>
      <SplitCell side={row.old} tone="old" changed={row.changed} wordWrap={wordWrap} />
      <SplitCell side={row.new} tone="new" changed={row.changed} wordWrap={wordWrap} />
    </>
  );
});

function SplitRows({
  rows,
  wordWrap,
  onExpandGap,
}: {
  readonly rows: ReadonlyArray<DifftasticRow>;
  readonly wordWrap: boolean;
  readonly onExpandGap: (id: number) => void;
}) {
  // One grid keeps both columns aligned across rows; unwrapped, each column grows to its longest
  // line and the body scrolls sideways, like the stacked layout.
  return (
    <div
      className={cn(
        "grid",
        wordWrap
          ? "grid-cols-2"
          : "w-max min-w-full grid-cols-[minmax(max-content,1fr)_minmax(max-content,1fr)]",
      )}
    >
      {rows.map((row) =>
        row.kind === "gap" ? (
          <GapRow
            key={`gap:${row.id}`}
            row={row}
            className="col-span-2"
            onExpandGap={onExpandGap}
          />
        ) : (
          <SplitRow
            key={`${row.old?.lineNumber ?? "-"}:${row.new?.lineNumber ?? "-"}`}
            row={row}
            wordWrap={wordWrap}
          />
        ),
      )}
    </div>
  );
}

const StackedLine = memo(function StackedLine({
  row,
  side,
  wordWrap,
}: {
  readonly row: DifftasticLineRow;
  readonly side: "old" | "new" | "both";
  readonly wordWrap: boolean;
}) {
  const display = side === "old" ? row.old! : row.new!;
  return (
    <div
      className="flex"
      {...(side === "both" ? {} : { "data-dt-line": side === "old" ? "deletion" : "addition" })}
    >
      <span data-dt-gutter className={LINE_NUMBER_CLASS}>
        {side !== "new" && row.old ? row.old.lineNumber + 1 : ""}
      </span>
      <span data-dt-gutter className={LINE_NUMBER_CLASS}>
        {side !== "old" && row.new ? row.new.lineNumber + 1 : ""}
      </span>
      <span
        className={cn(
          "w-4 shrink-0 select-none text-center",
          side === "old" && "text-diff-deletion-foreground",
          side === "new" && "text-diff-addition-foreground",
        )}
      >
        {side === "old" ? "-" : side === "new" ? "+" : " "}
      </span>
      <span className={cn("min-w-0 flex-1 pe-3", lineTextClass(wordWrap))}>
        <LineText side={display} tone={side === "old" ? "old" : "new"} />
      </span>
    </div>
  );
});

function StackedRows({
  rows,
  wordWrap,
  onExpandGap,
}: {
  readonly rows: ReadonlyArray<DifftasticRow>;
  readonly wordWrap: boolean;
  readonly onExpandGap: (id: number) => void;
}) {
  const stacked = useMemo(() => stackDifftasticRows(rows), [rows]);
  return (
    <div className={cn(!wordWrap && "w-max min-w-full")}>
      {stacked.map((entry) =>
        entry.kind === "gap" ? (
          <GapRow key={`gap:${entry.id}`} row={entry} onExpandGap={onExpandGap} />
        ) : (
          <StackedLine
            key={`${entry.side}:${entry.row.old?.lineNumber ?? "-"}:${entry.row.new?.lineNumber ?? "-"}`}
            row={entry.row}
            side={entry.side}
            wordWrap={wordWrap}
          />
        ),
      )}
    </div>
  );
}
