import type {
  CodexMcpOperation,
  CodexMcpResult,
  CodexMcpServerStatus,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { serverEnvironment } from "../state/server";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { readLocalApi } from "../localApi";

export function parseMcpToolArguments(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as unknown;
}

export function CodexMcpDialog({
  open,
  environmentId,
  instanceId,
  threadId,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const request = useAtomQueryRunner(serverEnvironment.codexMcp, { reportFailure: false });
  const [servers, setServers] = useState<ReadonlyArray<CodexMcpServerStatus>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CodexMcpResult | null>(null);
  const [toolTarget, setToolTarget] = useState<{ server: string; tool: string } | null>(null);
  const [toolArguments, setToolArguments] = useState("{}");
  const [trustedServer, setTrustedServer] = useState<string | null>(null);
  const [enabledOverrides, setEnabledOverrides] = useState<Record<string, boolean>>({});

  const run = useCallback(
    async (operation: CodexMcpOperation) => {
      setBusy(true);
      setError(null);
      const response = await request({
        environmentId,
        input: { instanceId, threadId, operation },
      });
      setBusy(false);
      if (response._tag === "Failure") {
        if (!isAtomCommandInterrupted(response)) {
          const cause = squashAtomCommandFailure(response);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return null;
      }
      setResult(response.value);
      if (response.value.type === "status") {
        setServers(response.value.servers);
      }
      return response.value;
    },
    [environmentId, instanceId, request, threadId],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    setResult(null);
    setToolTarget(null);
    setTrustedServer(null);
    void run({ type: "status" });
  }, [open, run]);

  const launchOauth = async (server: string) => {
    const response = await run({ type: "oauth", server });
    if (response?.type !== "oauth") return;
    const localApi = readLocalApi();
    if (localApi) {
      await localApi.shell.openExternal(response.authorizationUrl);
    } else {
      window.open(response.authorizationUrl, "_blank", "noopener,noreferrer");
    }
  };

  const callTool = async () => {
    if (!toolTarget || trustedServer !== toolTarget.server) return;
    let args: unknown;
    try {
      args = parseMcpToolArguments(toolArguments);
    } catch (cause) {
      setError(
        cause instanceof Error ? `Invalid tool arguments: ${cause.message}` : "Invalid JSON.",
      );
      return;
    }
    await run({
      type: "toolCall",
      server: toolTarget.server,
      tool: toolTarget.tool,
      arguments: args,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup aria-label="Codex MCP management" className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Codex MCP servers</DialogTitle>
          <DialogDescription>
            Inventory and control the MCP servers loaded by this thread&apos;s shared app-server.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          {servers.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              {busy ? "Loading MCP status..." : "No MCP servers are active for this thread."}
            </div>
          ) : (
            servers.map((server) => {
              const enabled = enabledOverrides[server.name] ?? true;
              return (
                <section key={server.name} className="rounded-xl border p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h3 className="font-medium">{server.serverInfo?.title ?? server.name}</h3>
                      <p className="text-xs text-muted-foreground">
                        {server.authStatus} · {server.tools.length} tools ·{" "}
                        {server.resources.length} resources
                      </p>
                      {server.serverInfo?.description ? (
                        <p className="mt-1 text-sm text-muted-foreground">
                          {server.serverInfo.description}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      {server.authStatus === "notLoggedIn" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void launchOauth(server.name)}
                        >
                          Sign in
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          const next = !enabled;
                          void run({ type: "setEnabled", server: server.name, enabled: next }).then(
                            (response) => {
                              if (response?.type === "setEnabled") {
                                setEnabledOverrides((current) => ({
                                  ...current,
                                  [server.name]: response.enabled,
                                }));
                              }
                            },
                          );
                        }}
                      >
                        {enabled ? "Disable" : "Enable"}
                      </Button>
                    </div>
                  </div>

                  {server.resources.length > 0 ? (
                    <div className="mt-4">
                      <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Resources
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {server.resources.map((resource) => (
                          <Button
                            key={resource.uri}
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() =>
                              void run({
                                type: "resourceRead",
                                server: server.name,
                                uri: resource.uri,
                              })
                            }
                          >
                            {resource.title ?? resource.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {server.tools.length > 0 ? (
                    <div className="mt-4">
                      <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                        Direct invocation
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {server.tools.map((tool) => (
                          <Button
                            key={tool.name}
                            size="sm"
                            variant={
                              toolTarget?.server === server.name && toolTarget.tool === tool.name
                                ? "default"
                                : "ghost"
                            }
                            onClick={() => {
                              setToolTarget({ server: server.name, tool: tool.name });
                              setTrustedServer(null);
                              setToolArguments("{}");
                            }}
                          >
                            {tool.title ?? tool.name}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
              );
            })
          )}

          {toolTarget ? (
            <section className="rounded-xl border bg-muted/15 p-4">
              <div className="font-medium">
                {toolTarget.server} / {toolTarget.tool}
              </div>
              <Textarea
                className="mt-3 font-mono text-xs"
                aria-label="MCP tool arguments"
                value={toolArguments}
                onChange={(event) => setToolArguments(event.currentTarget.value)}
              />
              <label className="mt-3 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={trustedServer === toolTarget.server}
                  onChange={(event) =>
                    setTrustedServer(event.currentTarget.checked ? toolTarget.server : null)
                  }
                />
                <span>
                  I trust this MCP server for this direct invocation. T3 does not persist or bypass
                  Codex approval policy.
                </span>
              </label>
              <Button
                className="mt-3"
                disabled={busy || trustedServer !== toolTarget.server}
                onClick={() => void callTool()}
              >
                Run tool
              </Button>
            </section>
          ) : null}

          {result && result.type !== "status" ? (
            <pre className="max-h-56 overflow-auto rounded-lg bg-muted/35 p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => void run({ type: "reload" }).then(() => run({ type: "status" }))}
          >
            Reload servers
          </Button>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
