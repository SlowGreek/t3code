/**
 * Workplace build analytics boundary.
 *
 * The upstream project sends anonymous product events to PostHog. This fork
 * deliberately keeps the service API so feature code remains easy to rebase,
 * but the production layer is a compile-time no-op with no HTTP client, host,
 * API key, identifier, buffer, timer, or network implementation in its
 * dependency graph.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  static readonly disabled = AnalyticsService.of({
    record: () => Effect.void,
    flush: Effect.void,
  });

  static readonly layerTest = Layer.succeed(AnalyticsService, AnalyticsService.disabled);
}

/** Analytics is permanently disabled in the workplace distribution. */
export const layer = AnalyticsService.layerTest;

export const layerTest = AnalyticsService.layerTest;
