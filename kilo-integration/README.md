# Kilo API integration

This directory contains the **exact, verified patch** that adds the minimal
versioned public task-state API to [Kilo Code](https://github.com/Kilo-Org/kilocode)
which `kilo-telegram-notifier` consumes. The patch was developed against the
Kilo Code repository at commit `bed1358` (v7.7.x line) and verified with the
Kilo repo's own typechecker, linter, and unit test runner.

- **Patch**: [`kilo-task-state-api.patch`](./kilo-task-state-api.patch)
- **Applies to**: `https://github.com/Kilo-Org/kilocode` (verified `git apply --check` against a fresh clone)
- **Status**: not yet merged upstream or shipped in a Kilo Code release

Until a Kilo Code release includes this API (or an equivalent), the notifier
activates, logs a diagnostic, and shows one warning — it never crashes, and it
never falls back to UI scraping.

## Architecture found (Kilo Code 7.7.x)

Inspection of the installed extension (`~/.vscode-server/extensions/kilocode.kilo-code-7.7.7-linux-x64`)
and the source repository (`packages/kilo-vscode` in the Kilo monorepo):

1. **Extension identifier**: `kilocode.kilo-code` (`packages/kilo-vscode/package.json`:
   `name: "kilo-code"`, `publisher: "kilocode"`).
2. **`activate()`**: `packages/kilo-vscode/src/extension.ts` — returned
   `undefined`; **no public inter-extension API existed**.
3. **Authoritative event transport**: the Kilo CLI backend (child process)
   emits events over SSE; `SdkSSEAdapter`
   (`src/services/cli-backend/sdk-sse-adapter.ts`) normalizes them and
   `KiloConnectionService.onEvent(listener)`
   (`src/services/cli-backend/connection-service.ts:289`) fans them out to
   extension-host consumers as `(event: SSEPayload, directory?)`.
4. **Authoritative task-state decision logic**: `AttentionService`
   (`src/services/attention/service.ts`) — the internal component that
   decides when a Kilo task needs the user's attention (sounds, OS toasts,
   VS Code notifications). Its event handling is the semantic precedent the
   patch mirrors exactly.

```
Kilo CLI backend (server, child process)
    | SSE global event stream
    v
SdkSSEAdapter ──> KiloConnectionService.onEvent(SSEPayload)
                        |                                   | (mirrored semantics)
                        v                                   v
                 AttentionService (internal)      TaskStateBridge (new, public)
                 sounds/toasts/notifications        vscode.Event<KiloTaskStateChangeEvent>
                                                             |
                                                             v
                                              kilo-telegram-notifier (apiVersion 1)
                                                             |
                                                             v
                                                    Telegram Bot API
```

## Internal → public state mapping

The bridge mirrors `AttentionService` semantics; nothing is guessed:

| Internal event | Condition | Public state |
| --- | --- | --- |
| `session.status` | `status.type` = `busy` / `retry` / `offline` | `running` (a status replay never lifts `needsInput`) |
| `session.status` | `status.type` = `idle` | ignored (turn close is the authoritative outcome) |
| `session.turn.close` | `reason: "completed"`, root session (no `parentID`), not an active-goal session, was active | `done` |
| `session.turn.close` | `reason: "error"` (or observed `session.error` before close) | `error` |
| `session.turn.close` | `reason: "interrupted"` / `"superseded"` | `cancelled` |
| `session.turn.close` | child session (`parentID` set) | no emission (subagent steps) |
| `question.asked` | new pending question id | `needsInput` |
| `permission.asked` | new pending permission id, **not** auto-approved | `needsInput` |
| `question.replied` / `question.rejected` / `permission.replied` | no pending input remains | `running` |
| `session.error` | while active, non-`MessageAbortedError` | held; emitted as `error` when the turn closes (a retry that recovers never fires a false error) |
| `session.error` | `MessageAbortedError` (deliberate abort) | falls through to the close reason (→ `cancelled`) |
| `session.deleted` / sync `session.deleted.1` | — | bookkeeping cleanup, no emission |
| unknown `status.type` / close `reason` | — | logged by name (no user content), no emission |

The bridge maintains a per-session state map (the SSE events carry no
`previousState`), emits only on real transitions (`previousState !== state`),
and freezes every emitted `KiloTaskStateChangeEvent` (read-only, no mutable
internal objects). Titles come from sync `session.updated.1` / `session.created.1`
payloads. Unknown status values are logged with their type name only.

## Public API contract (apiVersion 1)

Returned by Kilo Code's `activate()`:

```ts
type KiloTaskState = "running" | "done" | "error" | "needsInput" | "cancelled"

interface KiloTaskStateChangeEvent {
  taskId: string            // Kilo session id
  state: KiloTaskState
  previousState?: KiloTaskState
  title?: string            // session title, never a transcript
  message?: string          // short structural summary (permission/question label, error name)
  timestamp: string         // ISO-8601
}

interface KiloExtensionApi {
  apiVersion: 1
  onDidChangeTaskState: vscode.Event<KiloTaskStateChangeEvent>
  getCurrentTasks(): Promise<KiloTaskStateChangeEvent[]>
}
```

Properties:

- Versioned with `apiVersion: 1`; consumers validate the shape and version.
- Read-only: frozen API object, frozen event payloads, no internal maps leak.
- No secrets, prompts, transcripts, tool arguments, or file contents are
  exposed — only ids, states, titles, and short structural summaries.
- Disposed through `context.subscriptions`.
- Purely additive: `activate()` previously returned `undefined`, so returning
  the API breaks nothing; when no consumer subscribes, the bridge only
  mirrors events internally and Kilo behavior is unchanged.
- Auto-approve parity: the bridge receives the same `approve` hook as the
  attention service, so auto-approved permissions do not emit `needsInput`.

## Patch contents

`kilo-task-state-api.patch` touches exactly three paths:

| File | Change |
| --- | --- |
| `packages/kilo-vscode/src/services/public-api/task-state.ts` | new: `KiloTaskState`, `KiloTaskStateChangeEvent`, `KiloExtensionApi`, `TaskStateBridge` |
| `packages/kilo-vscode/src/extension.ts` | construct the bridge after the attention service, push to `context.subscriptions`, return `taskStateBridge.api`; annotate `activate(): Promise<KiloExtensionApi>` |
| `packages/kilo-vscode/tests/unit/public-api-task-state.test.ts` | new: 18 bun:test unit tests (mapping, transitions, unknown states, disposal, API shape) |

## Applying and verifying

```bash
git clone https://github.com/Kilo-Org/kilocode.git && cd kilocode
git apply --check /path/to/kilo-task-state-api.patch   # dry run
git apply /path/to/kilo-task-state-api.patch
bun install
cd packages/kilo-vscode
bun run check-types                                       # tsgo --noEmit
bun run lint                                              # eslint
bun test tests/unit/public-api-task-state.test.ts        # 18 tests
```

Verification actually performed on the patched tree (commit `bed1358`,
bun 1.4.2):

- `bun run check-types` — pass
- `bun run lint` — pass
- `bunx prettier --check` on the new files — pass
- `bun test tests/unit/public-api-task-state.test.ts` — 18/18 pass
- `bun test tests/unit/` — 6398 pass / 1 fail; the single failure
  (`kilo-provider-followup.test.ts`, "refreshes Git from the file path in a
  completed edit tool part", a 5000 ms timeout) also fails on the unpatched
  tree at the same commit, so it is pre-existing and unrelated.
- `git apply --check` on a fresh clone — applies cleanly.
