import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

export interface ElectronUpdaterFeedUrl {
  readonly provider: string;
  readonly url: string;
  readonly [key: string]: unknown;
}

export class ElectronUpdaterCheckForUpdatesError extends Schema.TaggedErrorClass<ElectronUpdaterCheckForUpdatesError>()(
  "ElectronUpdaterCheckForUpdatesError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to check for updates on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterDownloadUpdateError extends Schema.TaggedErrorClass<ElectronUpdaterDownloadUpdateError>()(
  "ElectronUpdaterDownloadUpdateError",
  {
    channel: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to download the update on channel ${this.channel ?? "default"}.`;
  }
}

export class ElectronUpdaterQuitAndInstallError extends Schema.TaggedErrorClass<ElectronUpdaterQuitAndInstallError>()(
  "ElectronUpdaterQuitAndInstallError",
  {
    channel: Schema.NullOr(Schema.String),
    isSilent: Schema.Boolean,
    isForceRunAfter: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Electron updater failed to quit and install the update on channel ${this.channel ?? "default"} (silent: ${this.isSilent}, force run after: ${this.isForceRunAfter}).`;
  }
}

export const ElectronUpdaterError = Schema.Union([
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
]);
export type ElectronUpdaterError = typeof ElectronUpdaterError.Type;
export const isElectronUpdaterError = Schema.is(ElectronUpdaterError);

export class ElectronUpdater extends Context.Service<
  ElectronUpdater,
  {
    readonly setFeedURL: (options: ElectronUpdaterFeedUrl) => Effect.Effect<void>;
    readonly setAutoDownload: (value: boolean) => Effect.Effect<void>;
    readonly setAutoInstallOnAppQuit: (value: boolean) => Effect.Effect<void>;
    readonly setChannel: (channel: string) => Effect.Effect<void>;
    readonly setAllowPrerelease: (value: boolean) => Effect.Effect<void>;
    readonly allowDowngrade: Effect.Effect<boolean>;
    readonly setAllowDowngrade: (value: boolean) => Effect.Effect<void>;
    readonly setFullChangelog: (value: boolean) => Effect.Effect<void>;
    readonly setDisableDifferentialDownload: (value: boolean) => Effect.Effect<void>;
    readonly checkForUpdates: Effect.Effect<void, ElectronUpdaterCheckForUpdatesError>;
    readonly downloadUpdate: Effect.Effect<void, ElectronUpdaterDownloadUpdateError>;
    readonly quitAndInstall: (options: {
      readonly isSilent: boolean;
      readonly isForceRunAfter: boolean;
    }) => Effect.Effect<void, ElectronUpdaterQuitAndInstallError>;
    readonly on: <Args extends ReadonlyArray<unknown>>(
      eventName: string,
      listener: (...args: Args) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/electron/ElectronUpdater") {}

const disabledCause = new Error("Automatic updates are disabled in the workplace distribution.");

export const make = ElectronUpdater.of({
  setFeedURL: () => Effect.void,
  setAutoDownload: () => Effect.void,
  setAutoInstallOnAppQuit: () => Effect.void,
  setChannel: () => Effect.void,
  setAllowPrerelease: () => Effect.void,
  allowDowngrade: Effect.succeed(false),
  setAllowDowngrade: () => Effect.void,
  setFullChangelog: () => Effect.void,
  setDisableDifferentialDownload: () => Effect.void,
  checkForUpdates: Effect.fail(
    new ElectronUpdaterCheckForUpdatesError({
      channel: null,
      cause: disabledCause,
    }),
  ),
  downloadUpdate: Effect.fail(
    new ElectronUpdaterDownloadUpdateError({
      channel: null,
      cause: disabledCause,
    }),
  ),
  quitAndInstall: ({ isSilent, isForceRunAfter }) =>
    Effect.fail(
      new ElectronUpdaterQuitAndInstallError({
        channel: null,
        isSilent,
        isForceRunAfter,
        cause: disabledCause,
      }),
    ),
  on: () => Effect.void,
});

export const layer = Layer.succeed(ElectronUpdater, make);
