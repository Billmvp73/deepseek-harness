# Agent Note: Start a blank Web session's work in a fresh git worktree

Status: implemented

English | [中文](2026-08-24-web-new-worktree-first-prompt.zh.md)

## Problem

A Web session works directly in the workspace directory it was created in. Users who want the agent's first turn isolated from their checkout — experiment branches, parallel tasks on one repository, a throwaway run they can delete wholesale — had no gesture for that: they would have to create a worktree by hand, register it as a workspace, and start a session there, losing the "just describe the task" flow of the blank-session Hero.

The natural place for the choice is the blank-session Hero row, beside the workspace and preset chips, because that row is exactly the set of choices that only exist before the first message. But the implementation cannot be client-side: the browser cannot run git, and a session's `cwd` is immutable creation metadata (`SessionHeader` is frozen), so "move this session to a worktree" is not expressible against the session store.

## Decision

### Product contract

The blank-session Hero row carries a "新建 worktree" checkbox between the Workspace chip and the agent-preset chip, rendered only while a session exists (the checkbox addresses a session's send intent; the no-session cold state has nothing to address). The intent is per-session in-memory state on the ConversationController, exposed to the Hero through the conversation inject face's `hooks` compartment; it is deliberately not a durable setting, because the choice only means anything for the session being started.

Checked, the session's first send attaches request-local `newWorktree` provenance to `session.prompt` — the same posture as `clientTimeZone`: never session, connection, or create state, so ACP/SDK callers and replays are unaffected. Unchecked sends are byte-identical to today's.

### Host relocation

On `newWorktree: true`, and only while the target session is still blank (no `turn/start`), the Host relocates the work: it resolves the session cwd, probes `git rev-parse --show-toplevel`, and — when a repository is found — runs `git worktree add -b wt-<timestamp> <parent>/<repo>.worktrees/wt-<timestamp>` from the toplevel. The work then starts in a NEW session created in that worktree (`ensureSession` with the source's resolved composition and the source's current model selection copied), and the prompt is delivered to that session's agent. The response names the new session via `sessionId`.

The new session still belongs to the SAME workspace as its source, but a plain `attachSession` would reject it: workspace membership requires the session's canonical cwd to equal the workspace path (the `sessionIds` projection filters on exactly that fact), and a worktree is a sibling directory. The workspace domain therefore gains a **linked-worktree account**: `Workspace.addWorktree(path)` registers a canonical directory (validated as an existing directory) that then participates in membership exactly like the workspace root — `attachSession` accepts a session whose cwd equals it, and the `sessionIds` getter and the durable prune include it. The relocation calls `addWorktree(worktreePath)` on the source workspace, then `attachSession(newSessionId)`, so the worktree session stays in the original sidebar group rather than spawning a new one. A loose source session with no registered workspace stays Ungrouped.

The active-session header shows this state with a small worktree branch chip beside the agent-preset label: the ui-conversation header-actions entry derives it (presentation-only) from the session row's `cwd` — a `.worktrees/<branch>` layout — so the user always sees which worktree a session runs in, without a new workspace group.

Relocation uses a fresh session identity because session headers are immutable; the source session's log was never touched, so it stays blank, hidden, and reusable by New Session. The client follows the response: the runtime Session notifies the manager through a new `onMoved` option, which merges the new list row synchronously (the `host/session-added` frame races this local insert; the fill-only upsert merge reconciles either order) and moves the selection. The source session deliberately does not fire `onEngaged` — flipping it non-blank would surface an empty session forever.

### Failure and ignorance semantics

A cwd outside any git repository (including a missing or unusable `git` binary) ignores the flag and prompts in place, exactly like an absent flag — the checkbox is safe to leave on across workspaces. A non-blank session ignores it too: the flag is a start-in-a-worktree intent, never a mid-conversation move, and the Host's blank check is authoritative regardless of what the client believes. A git failure after the repository check, or a failure starting the session inside the created worktree, rejects the whole prompt with the new `worktree-failed` code (workspace-attachment failure keeps the existing `workspace-attach-failed` semantics) and nothing reaches the model — silently working in the main tree after the user asked for a worktree would be the wrong outcome.

### Verification

Unit coverage on the git module uses real repositories in temp dirs: toplevel detection, null outside a repository, sibling-path/branch creation at HEAD, and distinct stamps across calls. Host proxy coverage drives `session.prompt` end-to-end against a fake agent factory: relocation creates the worktree session with the prompt delivered to it and the source untouched, non-repository and non-blank sessions ignore the flag, and an occupied worktree parent rejects with `worktree-failed` before anything is sent. Client coverage pins the payload provenance, the `onMoved` contract (no source blank flip), the manager merge-and-select, the Hero checkbox rendering/toggle, and the send path turning the intent into send options.

## Alternatives considered

**Mutate the live session's header cwd.** Rejected: `SessionHeader` is deep-frozen creation metadata and storage backends key directories off it; a mutation API would cut against every cwd consumer and the durable format.

**Create the worktree at session-create/workspace-pick time.** Rejected: the checkbox lives on an already-created blank session, and creating a worktree on check (before any work) would orphan trees for checks the user never follows with a message. Work starting is the commit point.

**Do it client-side via a separate `createWorktree` RPC before prompting.** Rejected: it splits one intent across two RPCs, lets a non-browser caller bypass or desynchronize the pairing, and still needs the same host-side session creation. The prompt response's `sessionId` keeps one round trip and one authority.

**Return the flag as persisted session state.** Rejected: the choice is per-send provenance with no meaning after the first turn; request-local fields keep create/resume/fork state and replay unaffected.

## Consequences

The worktree directory and branch are user-visible filesystem/git state the Host creates without a confirmation step; deleting them is ordinary `git worktree remove`/`git branch -d` work, and the Host does not track or clean them up. Each relocation registers one linked-worktree path on the source Workspace (a sibling worktree is never under the workspace root, so membership requires the domain's linked-worktree account); the path stays linked for the workspace's lifetime and is only removed by editing the durable workspace record. A worktree session appears in the same sidebar group as its source, distinguished by the header branch chip rather than a new group. A blank session that got relocated remains in the store as blank; if the user navigates back to it and sends again with the checkbox still checked, they get another fresh worktree — which is the documented "always" semantics, not a leak. The `worktree-failed` error code joins the closed `RpcErrorDetailsMap`, so new carriers must carry its details shape.
