import type {
  CodexMcpResult,
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
import { Input } from "./ui/input";
import { serverEnvironment } from "../state/server";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";

type NativeThread = Extract<CodexMcpResult, { type: "threadList" }>["threads"][number];

export function nativeThreadTitle(thread: NativeThread): string {
  return (
    thread.name?.trim() ||
    thread.preview.trim().slice(0, 80) ||
    `Codex thread ${thread.providerThreadId.slice(0, 8)}`
  );
}

export function CodexThreadBrowserDialog({
  open,
  environmentId,
  instanceId,
  threadId,
  linkedProviderThreadIds,
  onOpenChange,
  onImport,
}: {
  readonly open: boolean;
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly linkedProviderThreadIds: ReadonlySet<string>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImport: (thread: NativeThread) => Promise<void>;
}) {
  const request = useAtomQueryRunner(serverEnvironment.codexMcp, { reportFailure: false });
  const [searchTerm, setSearchTerm] = useState("");
  const [archived, setArchived] = useState(false);
  const [threads, setThreads] = useState<ReadonlyArray<NativeThread>>([]);
  const [busy, setBusy] = useState(false);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (input: { readonly searchTerm: string; readonly archived: boolean }) => {
      setBusy(true);
      setError(null);
      const response = await request({
        environmentId,
        input: {
          instanceId,
          threadId,
          operation: {
            type: "threadList",
            ...(input.searchTerm.trim() ? { searchTerm: input.searchTerm.trim() } : {}),
            archived: input.archived,
          },
        },
      });
      setBusy(false);
      if (response._tag === "Failure") {
        if (!isAtomCommandInterrupted(response)) {
          const cause = squashAtomCommandFailure(response);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return;
      }
      if (response.value.type === "threadList") {
        setThreads(response.value.threads);
      }
    },
    [environmentId, instanceId, request, threadId],
  );

  useEffect(() => {
    if (!open) return;
    setSearchTerm("");
    setArchived(false);
    setImportingId(null);
    void load({ searchTerm: "", archived: false });
  }, [load, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup aria-label="Browse native Codex threads" className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Native Codex threads</DialogTitle>
          <DialogDescription>
            Search the app-server&apos;s authoritative thread catalog and link a conversation to
            this T3 project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void load({ searchTerm, archived });
            }}
          >
            <Input
              aria-label="Search native Codex threads"
              placeholder="Search titles"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.currentTarget.value)}
            />
            <Button type="submit" variant="outline" disabled={busy}>
              Search
            </Button>
          </form>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={archived}
              onChange={(event) => {
                const next = event.currentTarget.checked;
                setArchived(next);
                void load({ searchTerm, archived: next });
              }}
            />
            Show archived threads
          </label>

          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <div className="max-h-96 space-y-2 overflow-auto">
            {threads.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {busy ? "Loading native threads..." : "No matching Codex threads."}
              </div>
            ) : (
              threads.map((thread) => {
                const linked = linkedProviderThreadIds.has(thread.providerThreadId);
                return (
                  <div
                    key={thread.providerThreadId}
                    className="flex items-start justify-between gap-4 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {nativeThreadTitle(thread)}
                      </div>
                      <div className="mt-1 truncate text-xs text-muted-foreground">
                        {thread.cwd}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={linked || busy || importingId !== null}
                      onClick={() => {
                        setImportingId(thread.providerThreadId);
                        void onImport(thread)
                          .then(() => onOpenChange(false))
                          .catch((cause: unknown) => {
                            setError(cause instanceof Error ? cause.message : String(cause));
                          })
                          .finally(() => setImportingId(null));
                      }}
                    >
                      {linked
                        ? "Linked"
                        : importingId === thread.providerThreadId
                          ? "Linking..."
                          : "Link"}
                    </Button>
                  </div>
                );
              })
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
