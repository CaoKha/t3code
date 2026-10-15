import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId, ReviewStructuralDiffTarget } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { cn } from "~/lib/utils";
import {
  buildDifftasticRows,
  segmentLine,
  stackDifftasticRows,
  type DifftasticGapRow,
  type DifftasticLineRow,
  type DifftasticSide,
} from "~/lib/difftasticRows";
import { getDiffLineStat, resolveFileDiffPath } from "~/lib/diffRendering";
import { useEnvironmentQuery } from "~/state/query";
import { reviewEnvironment } from "~/state/review";
import { DiffFilePathCopyButton } from "../DiffFilePathCopyButton";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { Button } from "../ui/button";

export interface DifftasticFile {
  readonly fileKey: string;
  readonly fileDiff: FileDiffMetadata;
  readonly collapsed: boolean;
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
  readonly selectedFileKey: string | null;
  readonly revealRequestId: number;
  readonly onToggleCollapsed: (fileKey: string) => void;
  readonly onOpenFile: (filePath: string) => void;
  readonly onFileContextMenu: (filePath: string, event: MouseEvent) => void;
}

/** Renders each changed file with difftastic's structural diff instead of a line patch. */
export function DifftasticDiffView({
  environmentId,
  files,
  resolveTarget,
  cacheKey,
  layout,
  wordWrap,
  selectedFileKey,
  revealRequestId,
  onToggleCollapsed,
  onOpenFile,
  onFileContextMenu,
}: DifftasticDiffViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedFileKey) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-file-key="${CSS.escape(selectedFileKey)}"]`,
    );
    target?.scrollIntoView({ block: "start" });
  }, [selectedFileKey, revealRequestId]);

  return (
    <div ref={scrollRef} className="h-full min-h-0 overflow-auto bg-background">
      {files.map((file) => (
        <DifftasticFileSection
          key={file.fileKey}
          environmentId={environmentId}
          file={file}
          target={resolveTarget(file.fileDiff)}
          cacheKey={cacheKey}
          layout={layout}
          wordWrap={wordWrap}
          onToggleCollapsed={onToggleCollapsed}
          onOpenFile={onOpenFile}
          onFileContextMenu={onFileContextMenu}
        />
      ))}
    </div>
  );
}

const DifftasticFileSection = memo(function DifftasticFileSection({
  environmentId,
  file,
  target,
  cacheKey,
  layout,
  wordWrap,
  onToggleCollapsed,
  onOpenFile,
  onFileContextMenu,
}: {
  readonly environmentId: EnvironmentId;
  readonly file: DifftasticFile;
  readonly target: ReviewStructuralDiffTarget | null;
  readonly cacheKey: string;
  readonly layout: "stacked" | "split";
  readonly wordWrap: boolean;
  readonly onToggleCollapsed: (fileKey: string) => void;
  readonly onOpenFile: (filePath: string) => void;
  readonly onFileContextMenu: (filePath: string, event: MouseEvent) => void;
}) {
  const filePath = resolveFileDiffPath(file.fileDiff);
  const stat = useMemo(() => getDiffLineStat([file.fileDiff]), [file.fileDiff]);
  return (
    <section data-file-key={file.fileKey} className="border-b border-border/70">
      <header
        className="sticky top-0 z-10 flex h-9 items-center gap-1.5 border-b border-border/60 bg-background/95 px-2 text-xs backdrop-blur-sm"
        onContextMenu={(event) => onFileContextMenu(filePath, event)}
      >
        <Button
          size="icon-micro"
          variant="ghost"
          aria-label={file.collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`}
          aria-expanded={!file.collapsed}
          onClick={() => onToggleCollapsed(file.fileKey)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", !file.collapsed && "rotate-90")}
          />
        </Button>
        <button
          type="button"
          className="min-w-0 truncate font-mono text-foreground hover:underline"
          onClick={() => onOpenFile(filePath)}
        >
          {file.fileDiff.prevName && file.fileDiff.prevName !== filePath
            ? `${file.fileDiff.prevName} → ${filePath}`
            : filePath}
        </button>
        <DiffFilePathCopyButton filePath={filePath} />
        <span className="ms-auto shrink-0">
          <DiffStatLabel additions={stat.additions} deletions={stat.deletions} />
        </span>
      </header>
      {file.collapsed ? null : target === null ? (
        <DifftasticNotice>Structural diff is not available for this file.</DifftasticNotice>
      ) : (
        <DifftasticFileBody
          environmentId={environmentId}
          target={target}
          cacheKey={cacheKey}
          layout={layout}
          wordWrap={wordWrap}
        />
      )}
    </section>
  );
});

function DifftasticNotice({ children }: { readonly children: React.ReactNode }) {
  return <p className="px-3 py-2 text-2xs text-muted-foreground">{children}</p>;
}

function DifftasticFileBody({
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
  const rows = useMemo(
    () => (result?.status === "changed" ? buildDifftasticRows(result, expandedGapIds) : []),
    [expandedGapIds, result],
  );

  if (!result) {
    return query.error ? (
      <DifftasticNotice>
        <span className="text-error/80">
          {query.error.includes("review.getStructuralDiff")
            ? "difftastic is not available here: this environment runs a T3 server without structural diff support. Use the standard diff, or update that server to a build that includes it."
            : query.error}
        </span>
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

  const expandGap = (id: number) => setExpandedGapIds((current) => new Set([...current, id]));

  return (
    <div
      className={cn(
        "difftastic-surface bg-code font-mono leading-5",
        !wordWrap && layout === "stacked" && "overflow-x-auto",
      )}
    >
      {result.language ? (
        <div className="px-3 pt-1 text-2xs text-muted-foreground/70">{result.language}</div>
      ) : null}
      {layout === "split" ? (
        <SplitRows rows={rows} onExpandGap={expandGap} />
      ) : (
        <StackedRows rows={rows} wordWrap={wordWrap} onExpandGap={expandGap} />
      )}
    </div>
  );
}

function GapRow({
  row,
  onExpandGap,
}: {
  readonly row: DifftasticGapRow;
  readonly onExpandGap: (id: number) => void;
}) {
  return (
    <button
      type="button"
      className="block w-full bg-muted/40 px-3 py-0.5 text-start font-sans text-2xs text-muted-foreground hover:bg-muted/70"
      onClick={() => onExpandGap(row.id)}
    >
      ⋯ {row.hiddenCount} unchanged {row.hiddenCount === 1 ? "line" : "lines"}
    </button>
  );
}

const LINE_NUMBER_CLASS =
  "w-12 shrink-0 select-none pe-2 text-end tabular-nums text-muted-foreground/50";

function LineText({ side, tone }: { readonly side: DifftasticSide; readonly tone: "old" | "new" }) {
  const segments = segmentLine(side.text, side.changes);
  return (
    <>
      {segments.map((segment) =>
        segment.novel ? (
          <span
            key={segment.start}
            className={cn(
              "rounded-xs",
              tone === "old"
                ? "bg-diff-deletion/25 text-diff-deletion-foreground"
                : "bg-diff-addition/25 text-diff-addition-foreground",
            )}
          >
            {segment.text}
          </span>
        ) : (
          <span key={segment.start}>{segment.text}</span>
        ),
      )}
      {side.text.length === 0 ? "​" : null}
    </>
  );
}

function SplitCell({
  side,
  tone,
  changed,
}: {
  readonly side: DifftasticSide | null;
  readonly tone: "old" | "new";
  readonly changed: boolean;
}) {
  if (side === null) {
    return <div className="flex min-w-0 flex-1 bg-muted/30" />;
  }
  const novel = changed && (side.changes.length > 0 || side.text.length === 0);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-1",
        novel && (tone === "old" ? "bg-diff-deletion/8" : "bg-diff-addition/8"),
      )}
    >
      <span className={LINE_NUMBER_CLASS}>{side.lineNumber + 1}</span>
      <span className="min-w-0 flex-1 pe-2 break-all whitespace-pre-wrap">
        <LineText side={side} tone={tone} />
      </span>
    </div>
  );
}

function SplitRows({
  rows,
  onExpandGap,
}: {
  readonly rows: ReadonlyArray<DifftasticGapRow | DifftasticLineRow>;
  readonly onExpandGap: (id: number) => void;
}) {
  return (
    <div>
      {rows.map((row) =>
        row.kind === "gap" ? (
          <GapRow key={`gap:${row.id}`} row={row} onExpandGap={onExpandGap} />
        ) : (
          <div
            key={`${row.old?.lineNumber ?? "-"}:${row.new?.lineNumber ?? "-"}`}
            className="flex divide-x divide-border/40"
          >
            <SplitCell side={row.old} tone="old" changed={row.changed} />
            <SplitCell side={row.new} tone="new" changed={row.changed} />
          </div>
        ),
      )}
    </div>
  );
}

function StackedRows({
  rows,
  wordWrap,
  onExpandGap,
}: {
  readonly rows: ReadonlyArray<DifftasticGapRow | DifftasticLineRow>;
  readonly wordWrap: boolean;
  readonly onExpandGap: (id: number) => void;
}) {
  const stacked = useMemo(() => stackDifftasticRows(rows), [rows]);
  return (
    <div className={cn(!wordWrap && "w-max min-w-full")}>
      {stacked.map((entry) => {
        if (entry.kind === "gap") {
          return <GapRow key={`gap:${entry.id}`} row={entry} onExpandGap={onExpandGap} />;
        }
        const { row, side } = entry;
        const display = side === "old" ? row.old! : row.new!;
        const tone = side === "old" ? "old" : "new";
        return (
          <div
            key={`${side}:${row.old?.lineNumber ?? "-"}:${row.new?.lineNumber ?? "-"}`}
            className={cn(
              "flex",
              side === "old" && "bg-diff-deletion/8",
              side === "new" && "bg-diff-addition/8",
            )}
          >
            <span className={LINE_NUMBER_CLASS}>
              {side !== "new" && row.old ? row.old.lineNumber + 1 : ""}
            </span>
            <span className={LINE_NUMBER_CLASS}>
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
            <span
              className={cn(
                "min-w-0 flex-1 pe-3",
                wordWrap ? "break-all whitespace-pre-wrap" : "whitespace-pre",
              )}
            >
              <LineText side={display} tone={tone} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
