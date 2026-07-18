import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { classifyWorkplaceOutboundUrl, restrictWorkplaceHttpClient } from "./outboundPolicy.ts";

describe("workplace outbound policy", () => {
  it("allows only loopback and documented GitHub host families", () => {
    expect(classifyWorkplaceOutboundUrl("http://127.0.0.1:3773/ws").category).toBe("loopback");
    expect(classifyWorkplaceOutboundUrl("https://api.github.com/repos/o/r").category).toBe(
      "github",
    );
    expect(
      classifyWorkplaceOutboundUrl("https://copilot-proxy.githubusercontent.com/v1/engines")
        .category,
    ).toBe("copilot");
    expect(classifyWorkplaceOutboundUrl("https://github.com.evil.example/path")).toEqual({
      allowed: false,
      category: "rejected",
      hostname: "github.com.evil.example",
    });
    expect(classifyWorkplaceOutboundUrl("https://example.com")).toEqual({
      allowed: false,
      category: "rejected",
      hostname: "example.com",
    });
  });

  it.effect("rejects disallowed hosts before the transport executes", () =>
    Effect.gen(function* () {
      let executions = 0;
      const client = restrictWorkplaceHttpClient(
        HttpClient.make((request) =>
          Effect.sync(() => {
            executions += 1;
            return HttpClientResponse.fromWeb(request, new Response());
          }),
        ),
      );
      const error = yield* client
        .execute(HttpClientRequest.get("https://example.com/private?token=secret"))
        .pipe(Effect.flip);

      expect(error._tag).toBe("HttpClientError");
      expect(error.reason._tag).toBe("TransportError");
      expect(executions).toBe(0);
    }),
  );
});
