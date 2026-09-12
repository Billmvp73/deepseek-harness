# Agent Note: Fork feature carriage across an upstream sync

Status: implemented

English | [中文](2026-09-12-fork-feature-carriage-upstream-sync.zh.md)

## Problem

This deployment tracks upstream `deepseek-harness` while carrying local features that were never proposed upstream. Merging 2285 upstream commits onto a fork sitting at `0.1.2-alpha.1` moved every API those features touch: `ClientResult` became `RemoteResult`, flat Remote error codes became namespaced `RemoteErrorDetailsMap` keys, the `reject()` helper disappeared, and synchronous Session history reads were deprecated. A conflict-by-conflict merge resolves the text but leaves no record of which local features exist, where each one attaches to the host, or why an attachment point was chosen — so the next sync re-derives all of it from diff archaeology, and a feature silently disappears the moment a conflict is resolved in upstream's favor.

## Decision

Four local features are carried across upstream syncs, and each names its host attachment point.

**Prompt relocation into a fresh worktree.** [`SessionCommands.prompt`](../../../../packages/api/session-controller/src/commands.ts) accepts `newWorktree` on `SessionPromptRequest` and relocates a blank Session's first prompt into a new linked git worktree, returning the replacement `sessionId` in `SessionPromptValue`. The Client contract widens [`prompt`](../../../../packages/api/session-controller/src/client/contract/session.ts) with an `opts?: { newWorktree?: boolean }` parameter, and the [conversation service](../../../../packages/client/ui-conversation/src/client/service.ts) holds the per-Session request in a `newWorktreeSessions` store cleared with every other draft state. Two Remote error codes join upstream's namespaced map as `session/workspace-attach-failed` and `session/worktree-failed`; local codes take the `session/` namespace rather than the bare names the fork used before 0.1.5.

**Blank-Session detection reads the projection, not event history.** `sessionBlank` in `commands.ts` reads `sessionListMetadata.blank` through `ctx.sessionProjections.stateOf`, because [synchronous Session event reads](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.md) are prohibited in production source. The projection registered by [the Session list](../../../../packages/api/session-controller/src/list.ts) is the same `blank` authority the Session list publishes, so the relocation decision and the list agree by construction instead of by two independent scans.

**Workspace worktree inventory.** [`WorkspaceSpec`](../../../../packages/workspace/workspace/src/spec.ts) carries `worktreePaths` beside `sessionIds`, defaulted to `[]` so persisted pre-fork workspace files parse. `WorkspaceView` requires the field, so every client fixture constructing a view supplies it.

**Model-selection search.** [`ModelSelect`](../../../../packages/client/ui-model-selection/src/client/ModelSelect.tsx) filters the provider-grouped catalog by typed text and clears it, alongside upstream's later body-portalled menu card. Both behaviors are pinned by their own `it(...)` blocks; the search test is the one that proves the local feature survived the merge.

Branded ids cross this boundary through `brandString<SessionId>(value)`. Upstream imports `SessionId` as a type, so the fork's `z.string().transform(SessionId)` and `SessionId(\`session-${randomUUID()}\`)` forms no longer compile; `brandString` is what upstream's own call sites in the same files use.

**The frozen Agent Note archive cannot hold fork rationale.** Upstream archived [`2026-07-22-pi-ai-transport-truncation-classification`](../../archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md) and [`2026-07-24-web-session-model-selector`](../../archived/feature/2026-07-24-web-session-model-selector.md), sealing their blob hashes in `.agents/notes/archived/manifest.json`. The fork had extended both files in place. Because [`verify-archived-agent-notes`](../../../../scripts/verify-archived-agent-notes.ts) treats changed sealed content as a hard error and `--write` seals only new artifacts, both triplets were restored to upstream's sealed bytes and the fork additions moved here. The text-classification branch they described still ships in [`classifyPiAiError`](../../../../packages/llm/llm-pi-ai/src/stream.ts), matching `network|connection|socket|fetch` with an optional `_error` suffix, `ECONN[A-Z]+`, and separator variants of `stream_read_error` and `connection_reset`; the model-selector search filter is the fork feature named above. A local change that would edit an archived note writes an active note instead.

## Alternatives considered

**Rebase the fork onto upstream instead of merging.** Thirty-four local commits across UI, API, and workspace packages would each replay against 2285 commits of API churn, so a mid-stack conflict leaves the tree in a state that neither builds nor describes a shipped feature. One merge commit resolves each conflict once with both sides visible, and [PR history policy](2026-08-02-native-github-stacks-and-optional-rebases.md) permits either for a standalone branch.

**Keep the fork's flat Remote error codes.** Upstream's `RemoteErrorDetailsMap` is a merge-extensible map keyed by namespace, and the Client's `remoteErrorOf()` dispatch reads that namespace. A bare `worktree-failed` key would type-check while sorting under no owner, so local codes take `session/`.

**Read `Session.snapshotEvents()` for blank detection and accept the deprecation.** The deprecation note permits the synchronous reads in test files only, and a second scan can disagree with the list's own `blank` value at the exact moment relocation is decided. Test files that assert on history — [`api-proxy-worktree.spec.ts`](../../../../packages/api/session-controller/tests/api-proxy-worktree.spec.ts) — do use `snapshotEvents()`, which is where the note allows it.

**Drop the fork features and adopt upstream unchanged.** The worktree-per-prompt flow and the workspace worktree inventory are the reason this deployment exists; the model-selection search is small enough to lose accidentally, which is why it is named here rather than left to a test file.

## Testing

`typecheck`, `lint`, and `test:docs` (16/16) pass. The four features are pinned by [`api-proxy-worktree.spec.ts`](../../../../packages/api/session-controller/tests/api-proxy-worktree.spec.ts), [`model-select.client.spec.tsx`](../../../../packages/client/ui-model-selection/tests/model-select.client.spec.tsx), and [`service-orchestration.client.spec.ts`](../../../../packages/client/ui-conversation/tests/service-orchestration.client.spec.ts), whose `prompt()` expectation carries the added `opts` argument. `verify-archived-agent-notes` reports 1884 frozen artifacts across six kinds, and `verify-translation-pairing` re-records the bilingual pairs the merge touched.

## Consequences

Every future sync has one file to read before resolving conflicts, and each local feature names the host API it depends on, so an upstream rename surfaces as a named attachment rather than a lost behavior. The cost is a fork-only note that upstream will never carry, and a standing obligation to update it whenever a local feature moves. Fork rationale that upstream later archives has to be relocated here, because the frozen archive admits no local edits.

## Deferred

Two full-suite failures are environment-dependent rather than merge-caused and remain unfixed: [`real-product.spec.ts`](../../../../packages/subagent/subagent-claude-code/tests/real-product.spec.ts) needs the real Claude Agent SDK and times out without it, and [`spawn-runner.spec.ts`](../../../../packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts) asserts a Windows PATH probe order that this Linux host does not reproduce.
