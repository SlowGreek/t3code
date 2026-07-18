import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  it.effect("keeps update network actions explicitly disabled", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* ElectronUpdater.make.allowDowngrade);
      assert.equal(
        (yield* ElectronUpdater.make.checkForUpdates.pipe(Effect.flip))._tag,
        "ElectronUpdaterCheckForUpdatesError",
      );
      assert.equal(
        (yield* ElectronUpdater.make.downloadUpdate.pipe(Effect.flip))._tag,
        "ElectronUpdaterDownloadUpdateError",
      );
      assert.equal(
        (yield* ElectronUpdater.make
          .quitAndInstall({ isSilent: false, isForceRunAfter: false })
          .pipe(Effect.flip))._tag,
        "ElectronUpdaterQuitAndInstallError",
      );
    }),
  );
});
