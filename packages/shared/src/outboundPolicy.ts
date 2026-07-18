import * as Effect from "effect/Effect";
import { HttpClient, HttpClientError, type HttpClientRequest } from "effect/unstable/http";

export const WORKPLACE_OUTBOUND_HOSTS = [
  "github.com",
  "api.github.com",
  "api.githubcopilot.com",
  "copilot-proxy.githubusercontent.com",
] as const;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const ALLOWED_SUFFIXES = [".githubcopilot.com", ".githubusercontent.com", ".githubassets.com"];

export type OutboundCategory = "loopback" | "github" | "copilot" | "rejected";

export interface OutboundDecision {
  readonly allowed: boolean;
  readonly category: OutboundCategory;
  readonly hostname: string;
}

export function classifyWorkplaceOutboundUrl(value: string | URL): OutboundDecision {
  let url: URL;
  try {
    url = value instanceof URL ? value : new URL(value);
  } catch {
    return { allowed: false, category: "rejected", hostname: "<invalid>" };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (LOOPBACK_HOSTS.has(hostname)) {
    return { allowed: true, category: "loopback", hostname };
  }
  if (
    hostname === "api.githubcopilot.com" ||
    hostname === "copilot-proxy.githubusercontent.com" ||
    hostname.endsWith(".githubcopilot.com")
  ) {
    return { allowed: true, category: "copilot", hostname };
  }
  if (
    hostname === "github.com" ||
    hostname === "api.github.com" ||
    ALLOWED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) {
    return { allowed: true, category: "github", hostname };
  }
  return { allowed: false, category: "rejected", hostname };
}

function rejectRequest(request: HttpClientRequest.HttpClientRequest, hostname: string) {
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      description: `Workplace outbound policy rejected host '${hostname}'.`,
    }),
  });
}

/** Restricts application-owned Effect HTTP traffic and emits metadata-only local audit records. */
export function restrictWorkplaceHttpClient(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return client.pipe(
    HttpClient.mapRequestEffect((request) => {
      const decision = classifyWorkplaceOutboundUrl(request.url);
      const audit = Effect.logInfo("workplace outbound request", {
        category: decision.category,
        hostname: decision.hostname,
        decision: decision.allowed ? "allowed" : "rejected",
      });
      return decision.allowed
        ? audit.pipe(Effect.as(request))
        : audit.pipe(Effect.andThen(Effect.fail(rejectRequest(request, decision.hostname))));
    }),
  );
}
