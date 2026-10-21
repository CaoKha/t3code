// @effect-diagnostics nodeBuiltinImport:off - the executed suite runs the generated install script through a real shell.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as Layer from "effect/Layer";

import * as ElectronApp from "./ElectronApp.ts";
import * as ElectronUpdater from "./ElectronUpdater.ts";
import * as ForkReleaseUpdater from "./ForkReleaseUpdater.ts";

const isDarwin = HostProcess.Platform.defaultValue() === "darwin";

const layerElectronApp = Layer.succeed(ElectronApp.ElectronApp, {
  metadata: Effect.succeed({
    appVersion: "1.0.0",
    appPath: "/Applications/T3 Code.app/Contents/Resources/app.asar",
    isPackaged: false,
    resourcesPath: "/Applications/T3 Code.app/Contents/Resources",
    runningUnderArm64Translation: false,
  }),
  name: Effect.succeed("T3 Code"),
  systemLocale: Effect.succeed("en-US"),
  whenReady: Effect.void,
  requestSingleInstanceLock: Effect.succeed(true),
  quit: Effect.void,
  exit: () => Effect.void,
  relaunch: () => Effect.void,
  setPath: () => Effect.void,
  setName: () => Effect.void,
  setAboutPanelOptions: () => Effect.void,
  setAppUserModelId: () => Effect.void,
  getAppMetrics: Effect.succeed([]),
  setAsDefaultProtocolClient: () => Effect.succeed(true),
  setDesktopName: () => Effect.void,
  setDockIcon: () => Effect.void,
  appendCommandLineSwitch: () => Effect.void,
  onBeforeQuitForUpdate: () => Effect.void,
  removeCommandLineSwitch: () => Effect.void,
  on: () => Effect.void,
} satisfies ElectronApp.ElectronApp["Service"]);

const assetUrl = "https://github.com/me/t3code/releases/download/v99.0.0/T3-Code.zip";
const layerReleases = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url.endsWith("/channel/latest.json")
          ? Response.json({
              version: "99.0.0",
              tag: "v99.0.0",
              commit: "0123456789abcdef0123456789abcdef01234567",
              assets: {
                "darwin-arm64": { name: "T3-Code.zip", url: assetUrl, sha256: "0".repeat(64) },
              },
            })
          : request.url === assetUrl
            ? new Response("not the published zip")
            : new Response(null, { status: 404 }),
      ),
    ),
  ),
);

describe.runIf(isDarwin)("ForkReleaseUpdater download", () => {
  it.effect("rejects a download that does not match its SHA-256 and removes it", () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-download-"));
    return Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;
      yield* updater.checkForUpdates;
      const exit = yield* Effect.exit(updater.downloadUpdate);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("does not match its SHA-256");
      expect(NodeFS.readdirSync(NodePath.join(home, "runtime", "fork-updates"))).toEqual([]);
    }).pipe(
      Effect.provide(
        ForkReleaseUpdater.layer.pipe(
          Layer.provide(Layer.mergeAll(layerElectronApp, layerReleases, NodeServices.layer)),
        ),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
      Effect.provideService(HostProcess.Environment, {
        T3CODE_FORK_RELEASE_REPOSITORY: "me/t3code",
        T3CODE_HOME: home,
      }),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
    );
  });
});

describe.runIf(isDarwin)("INSTALL_SCRIPT", () => {
  it("swaps the bundle once its parent process exits and removes the download", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-install-"));
    try {
      const staged = NodePath.join(root, "stage", "T3 Code.app");
      const bundle = NodePath.join(root, "Applications", "T3 Code.app");
      const versionDir = NodePath.join(root, "version");
      NodeFS.mkdirSync(staged, { recursive: true });
      NodeFS.mkdirSync(bundle, { recursive: true });
      NodeFS.mkdirSync(versionDir);
      NodeFS.writeFileSync(NodePath.join(staged, "marker"), "new");
      NodeFS.writeFileSync(NodePath.join(bundle, "marker"), "old");

      // The outer bash stands in for the app: it exits right after starting the helper
      // (`; exit` keeps bash from exec-ing the inner shell in its place).
      NodeChildProcess.execFileSync("/bin/bash", [
        "-c",
        'bash -c "$0" t3-fork-install "$1" "$2" 0 "$3"; exit',
        ForkReleaseUpdater.INSTALL_SCRIPT,
        staged,
        bundle,
        versionDir,
      ]);
      // The helper removes the version folder last; wait up to 10s for it.
      NodeChildProcess.execFileSync("/bin/bash", [
        "-c",
        'for _ in $(seq 100); do [ -e "$0" ] || exit 0; sleep 0.1; done',
        versionDir,
      ]);

      expect(NodeFS.readFileSync(NodePath.join(bundle, "marker"), "utf8")).toBe("new");
      expect(NodeFS.existsSync(`${bundle}.previous`)).toBe(false);
      expect(NodeFS.existsSync(`${bundle}.new`)).toBe(false);
      expect(NodeFS.existsSync(versionDir)).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
