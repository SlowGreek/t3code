# Workplace fork operations

The `SlowGreek/t3code` repository keeps two intentionally different branch roles:

- `main` is a clean mirror of `pingdotgg/t3code` `upstream/main`. Never merge fork product work into it.
- `codex-workplace` is the integration branch for workplace-only product and security changes. Every fork pull request targets this branch.

The `Workplace target guard` workflow rejects pull requests in this repository whose base is not `codex-workplace`.

## Safe upstream sync

```bash
git fetch upstream
git switch main
git merge --ff-only upstream/main
git push origin main
git switch codex-workplace
git merge main
git push origin codex-workplace
```

Do not force-push either protected branch. Resolve workplace integration conflicts on `codex-workplace`; never resolve them by adding fork behavior to `main`.

## Runtime architecture

Each configured local Codex environment owns one long-lived `codex app-server` process. T3 opens, resumes, and multiplexes native Codex threads over that connection. Native notifications and callbacks are routed by Codex `threadId`; closing a T3 thread removes its routed handlers but does not terminate the environment connection. The app-server remains authoritative for thread state and history.

At initialization T3 probes `collaborationMode/list` over the raw app-server channel and rejects unavailable requested modes. App-server versions that explicitly report method-not-found use the legacy `default`/`plan` set. T3 supplies mode-specific developer instructions only for those selected Codex modes to preserve the existing browser-preview integration; it does not replace base Codex instructions.

T3-only metadata (workspace presentation, local checkpoints, and GUI state) remains in T3 persistence. It must not replace or synthesize Codex lifecycle state when the app-server provides an authoritative operation.

Native app-server archive, unarchive, delete, rename, compact, and review operations are used for active Codex threads. Review targets include uncommitted changes, a base branch, one commit, or custom instructions, with inline or detached delivery.

Typed app-server callbacks cover MCP elicitation, granular permission approval, dynamic client tools, current-time reads, and token refresh compatibility. Unknown requests receive a visible method-not-found response instead of hanging. Unknown notifications and newly introduced Codex events are retained through the typed `runtime.raw` extension channel and rendered in the thread activity log.

Codex question metadata is preserved for optionless free text, Other answers, secrets, mixed question sets, and MCP multi-select fields. Secret answers use a password control and are never rendered as visible composer text.

The command palette exposes native MCP management for an active Codex thread. Inventory, OAuth initiation/completion notifications, resource reads, direct tool invocation, server reload, and per-server enablement all use the shared app-server connection. Direct invocation requires an explicit per-server trust confirmation each time; T3 does not persist that confirmation or bypass Codex approval policy.

When T3 creates a Git worktree it can apply the source checkout's current tracked diff with `applyCurrentChanges`. It also copies ignored `AGENTS.override.md` automatically. A repository may list additional untracked local files or directories in `.worktreeinclude`, one repository-relative path per line. Blank lines and `#` comments are ignored; absolute and parent-traversal paths are rejected.

Managed cleanup callers can pass `snapshotPath` when removing a worktree. T3 copies the complete worktree before removal and rejects snapshot destinations inside the worktree. A subsequent create can pass `restoreSnapshotPath`; T3 restores the snapshot while preserving the new linked-worktree `.git` metadata.

## Security posture

- Desktop and server listeners bind to `127.0.0.1`.
- Product analytics is a compile-time no-op with no analytics HTTP implementation.
- Codex subprocesses receive `DO_NOT_TRACK=1`, `OTEL_SDK_DISABLED=true`, `CODEX_TELEMETRY_DISABLED=1`, and `CODEX_ANALYTICS_ENABLED=false`.
- T3 Connect and Clerk provider initialization are disabled. Environment variables and embedded public keys cannot re-enable them.
- Cloudflare connector discovery, download, installation, and runtime layers are replaced with explicit disabled services.
- `electron-updater` is not a desktop runtime dependency. Update actions remain visibly disabled.
- T3 MCP credentials are scoped to a Codex thread and passed in that thread's native config rather than shared process environment variables.
- Step 11 automation scheduling and voice/realtime UX are intentionally deferred. Realtime protocol events remain observable, but this fork does not advertise a voice product surface.

## Outbound endpoints

Application-owned network clients may contact only loopback services and the following GitHub/Copilot host families when their corresponding feature is used:

| Category                      | Hosts                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------- |
| GitHub API and authentication | `github.com`, `api.github.com`                                                        |
| GitHub content                | `*.githubusercontent.com`, `*.githubassets.com`                                       |
| GitHub Copilot                | `api.githubcopilot.com`, `*.githubcopilot.com`, `copilot-proxy.githubusercontent.com` |
| Local sidecars                | `127.0.0.1`, `localhost`, `::1`                                                       |

Provider subprocesses and user-started terminal commands are separate trust boundaries: their network behavior is controlled by the provider sandbox and user permissions, not by T3's application HTTP client.

Outbound audit records are local-only and must contain category, normalized hostname, decision, and timestamp. They must never contain URL paths, query strings, request bodies, authorization headers, tokens, prompts, repository contents, or user identifiers.

## Reproducible builds and SBOM

Use the lockfile and the repository-pinned toolchain:

```bash
pnpm install --frozen-lockfile
pnpm build:reproducible
SOURCE_DATE_EPOCH="$(git show -s --format=%ct HEAD)" pnpm run sbom
```

`build:reproducible` fixes locale, timezone, CI mode, and `SOURCE_DATE_EPOCH` to the commit timestamp before running the workspace build. `sbom` uses pnpm's lockfile-only SPDX generator and writes `dist/sbom.spdx.json` without executing dependency lifecycle scripts.

Before release, run:

```bash
vp check
vp run typecheck
vp test
```
