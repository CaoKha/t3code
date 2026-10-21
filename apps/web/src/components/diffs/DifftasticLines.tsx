import { createContext, memo, use } from "react";

import {
  isTintedSide,
  segmentLine,
  stackDifftasticRows,
  type DifftasticGapRow,
  type DifftasticLineRow,
  type DifftasticRow,
  type DifftasticSegment,
  type DifftasticSide,
  type DifftasticSyntaxToken,
} from "~/lib/difftasticRows";
import { cn } from "~/lib/utils";

export type DifftasticSyntaxLines = ReadonlyArray<ReadonlyArray<DifftasticSyntaxToken>>;

export interface DifftasticSyntax {
  readonly old: DifftasticSyntaxLines | null;
  readonly new: DifftasticSyntaxLines | null;
}

type Tone = "old" | "new";

// Context, so tokens arriving after the first paint re-render only the line text, not every row.
const SyntaxContext = createContext<DifftasticSyntax>({ old: null, new: null });

/** One file's rows in the chosen layout. */
export function DifftasticLines({
  rows,
  layout,
  wordWrap,
  syntax,
  onExpandGap,
}: {
  readonly rows: ReadonlyArray<DifftasticRow>;
  readonly layout: "stacked" | "split";
  readonly wordWrap: boolean;
  readonly syntax: DifftasticSyntax;
  readonly onExpandGap: (id: number) => void;
}) {
  return (
    <SyntaxContext value={syntax}>
      {layout === "split" ? (
        <SplitRows rows={rows} wordWrap={wordWrap} onExpandGap={onExpandGap} />
      ) : (
        <StackedRows rows={rows} wordWrap={wordWrap} onExpandGap={onExpandGap} />
      )}
    </SyntaxContext>
  );
}

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
  // Shiki's FontStyle bit flags.
  const fontStyle = segment.fontStyle ?? 0;
  return {
    ...(segment.color ? { color: segment.color } : {}),
    ...(fontStyle & 1 ? { fontStyle: "italic" } : {}),
    ...(fontStyle & 2 ? { fontWeight: 700 } : {}),
    ...(fontStyle & 4 ? { textDecoration: "underline" } : {}),
  } as const;
}

function LineText({ side, tone }: { readonly side: DifftasticSide; readonly tone: Tone }) {
  const syntaxLine = use(SyntaxContext)[tone]?.[side.lineNumber];
  // A fragment, not the bare array: the compiler only memoizes this as a component when it
  // returns JSX, since `use` alone does not count as a hook call for that inference.
  return (
    <>
      {segmentLine(side.text, side.changes, syntaxLine).map((segment) => (
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
      ))}
    </>
  );
}

function SplitCell({
  side,
  counterpart,
  tone,
  wordWrap,
}: {
  readonly side: DifftasticSide | null;
  readonly counterpart: DifftasticSide | null;
  readonly tone: Tone;
  readonly wordWrap: boolean;
}) {
  const divider = tone === "old" && "border-e border-border/40";
  if (side === null) {
    return <div data-dt-empty className={cn("min-w-0", divider)} />;
  }
  return (
    <div
      className={cn("flex min-w-0", divider)}
      {...(isTintedSide(side, counterpart)
        ? { "data-dt-line": tone === "old" ? "deletion" : "addition" }
        : {})}
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
      <SplitCell side={row.old} counterpart={row.new} tone="old" wordWrap={wordWrap} />
      <SplitCell side={row.new} counterpart={row.old} tone="new" wordWrap={wordWrap} />
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
  // stackDifftasticRows emits "old" only for rows with an old line, "new" and "both" with a new one.
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
  return (
    <div className={cn(!wordWrap && "w-max min-w-full")}>
      {stackDifftasticRows(rows).map((entry) =>
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
