import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadDeletionReactor,
  type ThreadDeletionReactorShape,
} from "../Services/ThreadDeletionReactor.ts";

type ThreadDeletedEvent = Extract<OrchestrationEvent, { type: "thread.deleted" }>;
type ThreadLifecycleEvent = Extract<
  OrchestrationEvent,
  {
    type: "thread.deleted" | "thread.archived" | "thread.unarchived" | "thread.meta-updated";
  }
>;

export const logCleanupCauseUnlessInterrupted = <R, E>({
  effect,
  message,
  threadId,
}: {
  readonly effect: Effect.Effect<void, E, R>;
  readonly message: string;
  readonly threadId: ThreadDeletedEvent["payload"]["threadId"];
}): Effect.Effect<void, E, R> =>
  effect.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logDebug(message, {
        threadId,
        cause: Cause.pretty(cause),
      });
    }),
  );

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const terminalManager = yield* TerminalManager.TerminalManager;

  const stopProviderSession = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: providerService.stopSession({ threadId }),
      message: "thread deletion cleanup skipped provider session stop",
      threadId,
    });

  const closeThreadTerminals = (threadId: ThreadDeletedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId, deleteHistory: true }),
      message: "thread deletion cleanup skipped terminal close",
      threadId,
    });

  const processThreadDeleted = Effect.fn("processThreadDeleted")(function* (
    event: ThreadLifecycleEvent,
  ) {
    const { threadId } = event.payload;
    switch (event.type) {
      case "thread.archived":
        yield* providerService.syncThreadLifecycle({
          threadId,
          action: { type: "archive" },
        });
        return;
      case "thread.unarchived":
        yield* providerService.syncThreadLifecycle({
          threadId,
          action: { type: "unarchive" },
        });
        return;
      case "thread.meta-updated":
        if (event.payload.title) {
          yield* providerService.syncThreadLifecycle({
            threadId,
            action: { type: "name", name: event.payload.title },
          });
        }
        return;
      case "thread.deleted":
        yield* providerService.syncThreadLifecycle({
          threadId,
          action: { type: "delete" },
        });
        yield* stopProviderSession(threadId);
        yield* closeThreadTerminals(threadId);
    }
  });

  const processThreadDeletedSafely = (event: ThreadLifecycleEvent) =>
    processThreadDeleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread deletion reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadDeletedSafely);

  const start: ThreadDeletionReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        switch (event.type) {
          case "thread.deleted":
          case "thread.archived":
          case "thread.unarchived":
          case "thread.meta-updated":
            return worker.enqueue(event);
          default:
            return Effect.void;
        }
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadDeletionReactorShape;
});

export const ThreadDeletionReactorLive = Layer.effect(ThreadDeletionReactor, make);
