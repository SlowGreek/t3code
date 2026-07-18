import { describe, expect, it } from "vite-plus/test";

import { getAutoUpdateDisabledReason } from "./DesktopUpdates.ts";

describe("DesktopUpdates workplace policy", () => {
  it("keeps packaged production updates disabled even when a feed exists", () => {
    expect(
      getAutoUpdateDisabledReason({
        isDevelopment: false,
        isPackaged: true,
        platform: "darwin",
        disabledByEnv: true,
        hasUpdateFeedConfig: true,
      }),
    ).toBe("Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.");
  });
});
