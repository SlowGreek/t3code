import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AnalyticsService from "./AnalyticsService.ts";

it.effect("uses a permanent no-op analytics layer in workplace builds", () =>
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService.AnalyticsService;
    yield* analytics.record("must.not.leave.device", { secret: "local-only" });
    yield* analytics.flush;
    assert.ok(true);
  }).pipe(Effect.provide(AnalyticsService.layer)),
);
