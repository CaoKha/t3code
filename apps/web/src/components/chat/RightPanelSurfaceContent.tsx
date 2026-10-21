import type {
  EditorId,
  EnvironmentId,
  PreviewAnnotationPayload,
  ProjectId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { Activity, lazy, Suspense, useState } from "react";
import type { ComposerImageAttachment, DraftId } from "../../composerDraftStore";
import type { ShortcutMatchContext } from "../../keybindings";
import { type RightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import {
  PersistentThreadTerminalPanel,
  type PersistentThreadTerminalPanelProps,
} from "../PersistentThreadTerminals";
import { pullRequestPanelContext } from "../pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "../pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "../pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "../pullRequest/PullRequestsUnavailableState";
import { ThreadPullRequestsPanel } from "../pullRequest/ThreadPullRequestsPanel";
import { type KeptSurface, keepRecentSurfaces, keptSurfaceSlot } from "./rightPanelKeepAlive.logic";

const PreviewPanel = lazy(() =>
  import("../preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const DiffPanel = lazy(() => import("../DiffPanel"));
const DevicePanel = lazy(() =>
  import("../device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);
const FilePreviewPanel = lazy(() => import("../files/FilePreviewPanel"));

export type RightPanelTerminalProps = Omit<
  PersistentThreadTerminalPanelProps,
  "visible" | "threadRef" | "surface"
>;

export interface RightPanelPullRequestProps {
  readonly capabilityKnown: boolean;
  readonly supported: boolean;
  readonly projectId: ProjectId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly linkedPullRequest: ThreadLinkedPullRequest | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
  /** Back to the pull request list; absent when there is no list to go back to. */
  readonly onBack: (() => void) | undefined;
}

export interface RightPanelFileProps {
  readonly projectName: string | null;
  readonly workspaceRoot: string | undefined;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

/**
 * How many surfaces stay mounted while hidden. Each keeps its DOM and React state, but a hidden
 * one runs no effects, so it holds no subscriptions and does no work until it is shown again.
 */
const KEPT_SURFACE_CAPACITY = 4;

interface RightPanelSurfaceContentProps {
  readonly surface: RightPanelSurface | null;
  /** Every surface open in the panel; a kept one that is no longer here is dropped. */
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly activeSurfaceId: string | null;
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly configuredPreviewUrls: ReadonlyArray<string>;
  readonly workspaceMutationId: string | null;
  readonly getShortcutContext: () => ShortcutMatchContext;
  readonly onSendAnnotation: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
  readonly onCloseSurface: (surface: RightPanelSurface) => void;
  readonly terminal: RightPanelTerminalProps;
  readonly pullRequest: RightPanelPullRequestProps;
  readonly files: RightPanelFileProps;
}

/**
 * The body of the thread's right panel. Surfaces the reader moved away from stay mounted but
 * hidden, so coming back to one finds it as it was left: folds, scroll, tabs and selections.
 */
export function RightPanelSurfaceContent(props: RightPanelSurfaceContentProps) {
  const { surface } = props;
  const threadKey = scopedThreadKey(props.threadRef);
  const [kept, setKept] = useState<{
    readonly threadKey: string;
    readonly surfaces: ReadonlyArray<KeptSurface>;
  }>({ threadKey, surfaces: [] });
  const previous = kept.threadKey === threadKey ? kept.surfaces : [];
  const keptSurfaces = keepRecentSurfaces(previous, surface, props.surfaces, KEPT_SURFACE_CAPACITY);
  if (kept.threadKey !== threadKey || keptSurfaces !== kept.surfaces) {
    setKept({ threadKey, surfaces: keptSurfaces });
  }

  const activeSlot = surface === null ? null : keptSurfaceSlot(surface);
  return (
    <>
      {keptSurfaces.map((entry) => {
        const active = entry.slot === activeSlot;
        const shown = active
          ? surface
          : props.surfaces.find((candidate) => candidate.id === entry.surfaceId);
        if (!shown) return null;
        return (
          <Activity key={entry.slot} mode={active ? "visible" : "hidden"}>
            <RightPanelSurfaceBody {...props} surface={shown} active={active} />
          </Activity>
        );
      })}
      {surface !== null && activeSlot === null ? (
        <RightPanelSurfaceBody {...props} surface={surface} active />
      ) : null}
    </>
  );
}

function RightPanelSurfaceBody(
  props: Omit<RightPanelSurfaceContentProps, "surface"> & {
    readonly surface: RightPanelSurface;
    readonly active: boolean;
  },
) {
  const { surface, threadRef } = props;
  const visible = props.visible && props.active;
  switch (surface.kind) {
    case "preview":
      return (
        <Suspense fallback={null}>
          <PreviewPanel
            mode="embedded"
            threadRef={threadRef}
            tabId={surface.resourceId}
            configuredUrls={props.configuredPreviewUrls}
            visible={visible}
            onSendAnnotation={props.onSendAnnotation}
          />
        </Suspense>
      );
    case "terminal":
      return (
        <PersistentThreadTerminalPanel
          {...props.terminal}
          visible={visible}
          threadRef={threadRef}
          surface={surface}
        />
      );
    case "diff":
      return (
        <Suspense fallback={null}>
          <DiffPanel
            key={scopedThreadKey(threadRef)}
            mode="embedded"
            composerDraftTarget={props.composerDraftTarget}
            workspaceMutationId={props.workspaceMutationId}
            visible={visible}
          />
        </Suspense>
      );
    case "pull-request": {
      const pullRequest = props.pullRequest;
      if (!pullRequest.capabilityKnown) return <PullRequestDetailGhost />;
      if (!pullRequest.supported) {
        return (
          <PullRequestsUnavailableState
            title="Pull requests unavailable"
            error="Update this environment's T3 Code server to browse pull requests."
          />
        );
      }
      return (
        <PullRequestDetailPanel
          getShortcutContext={props.getShortcutContext}
          shortcutsEnabled={visible && props.activeSurfaceId === surface.id}
          key={`${scopedThreadKey(threadRef)}:${surface.id}`}
          environmentId={props.environmentId}
          onSelectPullRequest={(reference) => {
            useRightPanelStore.getState().openPullRequest(threadRef, {
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
          }}
          threadRef={threadRef}
          reference={{
            projectId: surface.projectId as ProjectId,
            ...(surface.host ? { host: surface.host } : {}),
            repository: surface.repository,
            number: surface.number,
          }}
          initialTab={surface.detailTab ?? "summary"}
          onTabChange={(tab) => {
            useRightPanelStore.getState().setPullRequestDetailTab(threadRef, surface.id, tab);
          }}
          context={pullRequestPanelContext(
            {
              projectId: pullRequest.projectId,
              pullRequests: pullRequest.pullRequests,
              linkedPullRequest: pullRequest.linkedPullRequest,
              branchPullRequest: pullRequest.branchPullRequest,
            },
            surface,
          )}
          composerDraftTarget={props.composerDraftTarget}
          onBack={pullRequest.onBack}
        />
      );
    }
    case "pull-requests":
      return <ThreadPullRequestsPanel threadRef={threadRef} />;
    case "device":
      return (
        <Suspense fallback={null}>
          <DevicePanel
            mode="embedded"
            threadRef={threadRef}
            key={surface.id}
            surface={surface}
            visible={visible}
            onDismissSetup={() => {
              props.onCloseSurface(surface);
              useRightPanelStore.getState().show(threadRef);
            }}
          />
        </Suspense>
      );
    case "files":
    case "file": {
      const files = props.files;
      const attachment = surface.kind === "file" ? surface.attachment : undefined;
      if (!attachment && (files.projectName === null || !files.workspaceRoot)) return null;
      return (
        <Suspense fallback={null}>
          <FilePreviewPanel
            key={`${props.environmentId}:${
              attachment ? `attachment:${attachment.id}` : files.workspaceRoot
            }`}
            environmentId={props.environmentId}
            cwd={files.workspaceRoot ?? ""}
            projectName={files.projectName ?? ""}
            threadRef={threadRef}
            composerDraftTarget={props.composerDraftTarget}
            keybindings={props.keybindings}
            availableEditors={files.availableEditors}
            openInShortcutEnabled={visible}
            relativePath={surface.kind === "file" ? surface.relativePath : null}
            {...(attachment ? { attachment } : {})}
            revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
            revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
            onOpenFile={files.onOpenFile}
            onNavigateFolder={(relativePath, folderTrail, keepSource) =>
              useRightPanelStore
                .getState()
                .navigateFolder(threadRef, surface.id, relativePath, folderTrail, keepSource)
            }
            folderTrail={surface.folderTrail}
            onPendingChange={files.onPendingChange}
            selectedFilePending={surface.kind === "file" && files.pendingSurfaceIds.has(surface.id)}
            workspaceMutationId={props.workspaceMutationId}
          />
        </Suspense>
      );
    }
  }
}
