import { describe, expect, it } from "vite-plus/test";

import { resolveServerSelfUpdateCapability } from "./selfUpdate.ts";

describe("resolveServerSelfUpdateCapability", () => {
  it("prefers the desktop app, then the boot service, then respawn", () => {
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: true,
        launcherManaged: true,
        respawnManaged: true,
      }),
    ).toBe("desktop-managed");
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: false,
        launcherManaged: true,
        respawnManaged: true,
      }),
    ).toBe("boot-service");
    expect(
      resolveServerSelfUpdateCapability({
        desktopManaged: false,
        launcherManaged: false,
        respawnManaged: true,
      }),
    ).toBe("respawn");
  });

  it("offers no remote updates without an opt-in", () => {
    expect(
      resolveServerSelfUpdateCapability({ desktopManaged: false, launcherManaged: false }),
    ).toBeNull();
  });
});
