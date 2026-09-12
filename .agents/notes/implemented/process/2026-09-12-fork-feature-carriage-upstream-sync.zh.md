# Agent Note: Fork feature carriage across an upstream sync

Status: implemented

[English](2026-09-12-fork-feature-carriage-upstream-sync.md) | 中文

## Problem

本部署跟随上游 `deepseek-harness`，同时携带从未向上游提出的本地特性。把 2285 个上游提交合并到停留在 `0.1.2-alpha.1` 的 fork 上，这些特性触碰的每个 API 都变了：`ClientResult` 改名为 `RemoteResult`，扁平的 Remote 错误码变成带命名空间的 `RemoteErrorDetailsMap` 键，`reject()` 辅助函数消失，同步读取 Session 历史被废弃。逐个冲突地合并能解决文本，却不留下记录说明存在哪些本地特性、每个特性挂在宿主的什么位置、以及为什么选这个挂载点——于是下一次同步要靠 diff 考古重新推导，而某个冲突一旦按上游方向解决，特性就悄然消失。

## Decision

有四个本地特性跨上游同步携带，每一个都指明自己的宿主挂载点。

**把提示词迁移到新 worktree。**[`SessionCommands.prompt`](../../../../packages/api/session-controller/src/commands.ts) 在 `SessionPromptRequest` 上接受 `newWorktree`，把空白 Session 的首个提示词迁移到新建的 linked git worktree，并在 `SessionPromptValue` 中返回替换后的 `sessionId`。Client 契约给 [`prompt`](../../../../packages/api/session-controller/src/client/contract/session.ts) 加宽了一个 `opts?: { newWorktree?: boolean }` 参数，[会话服务](../../../../packages/client/ui-conversation/src/client/service.ts)把每个 Session 的请求放在 `newWorktreeSessions` store 中，与其他草稿状态一起清空。两个 Remote 错误码以 `session/workspace-attach-failed` 和 `session/worktree-failed` 加入上游带命名空间的映射；本地错误码采用 `session/` 命名空间，而不是 fork 在 0.1.5 之前使用的裸名。

**空白 Session 判定读投影，不读事件历史。**`commands.ts` 中的 `sessionBlank` 通过 `ctx.sessionProjections.stateOf` 读取 `sessionListMetadata.blank`，因为[同步读取 Session 事件](../architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)在生产源码中被禁止。[Session 列表](../../../../packages/api/session-controller/src/list.ts)注册的投影就是 Session 列表发布的同一个 `blank` 权威，因此迁移决定与列表由构造保证一致，而不是靠两次独立扫描。

**Workspace worktree 清单。**[`WorkspaceSpec`](../../../../packages/workspace/workspace/src/spec.ts) 在 `sessionIds` 旁携带 `worktreePaths`，默认为 `[]`，使 fork 之前持久化的 workspace 文件仍能解析。`WorkspaceView` 要求该字段，因此每个构造 view 的 client fixture 都提供它。

**模型选择搜索。**[`ModelSelect`](../../../../packages/client/ui-model-selection/src/client/ModelSelect.tsx) 按输入文本过滤按 provider 分组的目录并可清空，与上游后来加入的挂载到 body 的菜单卡片并存。两种行为各由自己的 `it(...)` 块钉住；搜索测试正是证明本地特性在合并中存活下来的那个。

带标记的 id 通过 `brandString<SessionId>(value)` 跨越这个边界。上游把 `SessionId` 作为类型导入，因此 fork 的 `z.string().transform(SessionId)` 与 `SessionId(\`session-${randomUUID()}\`)` 写法不再能编译；`brandString` 正是上游在同一批文件中自己的调用点所用的形式。

**冻结的 Agent Note 归档无法承载 fork 的理由。**上游归档了 [`2026-07-22-pi-ai-transport-truncation-classification`](../../archived/bug-fix/2026-07-22-pi-ai-transport-truncation-classification.md) 与 [`2026-07-24-web-session-model-selector`](../../archived/feature/2026-07-24-web-session-model-selector.md)，把它们的 blob 哈希封存在 `.agents/notes/archived/manifest.json` 中。fork 曾就地扩写过这两个文件。由于 [`verify-archived-agent-notes`](../../../../scripts/verify-archived-agent-notes.ts) 把已封存内容的变动视为硬错误，而 `--write` 只封存新产物，两套三元组都恢复为上游封存的字节，fork 的补充内容移到本文。它们描述的文本分类分支仍随 [`classifyPiAiError`](../../../../packages/llm/llm-pi-ai/src/stream.ts) 发布，匹配带可选 `_error` 后缀的 `network|connection|socket|fetch`、`ECONN[A-Z]+`，以及 `stream_read_error` 和 `connection_reset` 的分隔符变体；模型选择搜索过滤即上面点名的那个 fork 特性。今后会改动归档笔记的本地变更，改为写一份活跃笔记。

## Alternatives considered

**把 fork rebase 到上游而不是合并。**三十四个本地提交横跨 UI、API 与 workspace 包，每一个都要在 2285 个提交的 API 变动上重放，栈中途的一次冲突会让树处于既不能构建、也不描述任何已发布特性的状态。一次 merge commit 让每个冲突在两侧都可见的情况下只解决一次，而[PR 历史策略](2026-08-02-native-github-stacks-and-optional-rebases.zh.md)对独立分支允许两者任一。

**保留 fork 的扁平 Remote 错误码。**上游的 `RemoteErrorDetailsMap` 是按命名空间为键的可合并扩展映射，Client 的 `remoteErrorOf()` 分派读取该命名空间。裸的 `worktree-failed` 键能通过类型检查，却归属不到任何所有者，因此本地错误码采用 `session/`。

**用 `Session.snapshotEvents()` 做空白判定并接受废弃。**废弃笔记只在测试文件中允许这些同步读取，而第二次扫描可能恰在决定迁移的那一刻与列表自身的 `blank` 值不一致。断言历史的测试文件——[`api-proxy-worktree.spec.ts`](../../../../packages/api/session-controller/tests/api-proxy-worktree.spec.ts)——确实使用 `snapshotEvents()`，那正是笔记允许的位置。

**放弃 fork 特性，原封不动采用上游。**按提示词建 worktree 的流程与 workspace worktree 清单正是本部署存在的理由；模型选择搜索小到容易被无意丢掉，所以在此点名，而不是交给一个测试文件去守。

## Testing

`typecheck`、`lint` 与 `test:docs`（16/16）通过。[`elevation-styles.client.spec.ts`](../../../../packages/client/ui-theme/tests/elevation-styles.client.spec.ts) 中的细线门禁抓到了合并引入的唯一真实缺陷：模型选择搜索框以 `1px` 绘制中性色边框，而上游现在要求 `0.5px`。四个特性由 [`api-proxy-worktree.spec.ts`](../../../../packages/api/session-controller/tests/api-proxy-worktree.spec.ts)、[`model-select.client.spec.tsx`](../../../../packages/client/ui-model-selection/tests/model-select.client.spec.tsx) 与 [`service-orchestration.client.spec.ts`](../../../../packages/client/ui-conversation/tests/service-orchestration.client.spec.ts) 钉住，后者的 `prompt()` 期望携带新增的 `opts` 实参。`verify-archived-agent-notes` 报告六类共 1884 个冻结产物，`verify-translation-pairing` 重新记录合并触及的双语配对。

## Consequences

今后每次同步都有一个文件可在解决冲突前先读，每个本地特性都点明自己依赖的宿主 API，于是上游改名会表现为一个点名的挂载点，而不是一个丢失的行为。代价是一份上游永不会携带的 fork 专属笔记，以及本地特性每次移动都要更新它的长期义务。上游日后归档的 fork 理由必须搬到本文，因为冻结归档不接受任何本地修改。

## Deferred

六个全量测试文件在这台宿主上失败，无一由合并所致：合并改动的每个文件都不在它们的导入闭包内，因此它们的输入与上游 `c291e7961a` 逐字节一致。[`real-product.spec.ts`](../../../../packages/subagent/subagent-claude-code/tests/real-product.spec.ts) 需要真实的 Claude Agent SDK，缺少时超时。[`spawn-runner.spec.ts`](../../../../packages/subprocess/subprocess-local/tests/spawn-runner.spec.ts) 断言的 Windows PATH 探测顺序在这台 Linux 宿主上无法复现。[`subagent-acp.spec.ts`](../../../../packages/subagent/subagent-acp/tests/subagent-acp.spec.ts) 的收尾阶梯失败，因为这台宿主的 systemd 以 `Invalid argument` 拒绝向 scope 的辅助进程发送 `SIGKILL`。[`runtime.spec.ts`](../../../../packages/experimental/code-runtime-python/tests/runtime.spec.ts) 只在全量负载下触到 60 秒墙钟上限，单独运行通过。[`spill-local.spec.ts`](../../../../packages/spill/spill-local/tests/spill-local.spec.ts) 与 [`loader-composition.spec.ts`](../../../../packages/spill/spill-local/tests/loader-composition.spec.ts) 中的九个测试观察到启动清理扫描什么都不删且不报警告；原因未查明，且归属于该包而非本次同步。
