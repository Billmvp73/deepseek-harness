# Agent Note: 让空白 Web 会话的工作从全新的 git worktree 开始

Status: implemented

[English](2026-08-24-web-new-worktree-first-prompt.md) | 中文

## 问题

Web 会话直接在创建时所在的工作区目录里工作。想让 agent 的第一轮工作与自己的 checkout 隔离的用户——实验分支、同一仓库上的并行任务、可以整体删除的一次性运行——没有任何入口：他们必须手工创建 worktree、把它注册为工作区、再在那里启动会话，丢掉了空白会话 Hero"直接描述任务"的流程。

这个选择的自然位置是空白会话的 Hero 行，紧挨工作区与预设 chip，因为那一行恰好是"只在第一条消息之前才存在"的选择集合。但实现不能放在客户端：浏览器无法运行 git，而会话的 `cwd` 是不可变的创建元数据（`SessionHeader` 被冻结），所以"把这个会话移到 worktree"对 session store 来说根本无法表达。

## 决策

### 产品约定

空白会话的 Hero 行在工作区 chip 与预设 chip 之间有一个"新建 worktree"复选框，只在当前存在会话时渲染（复选框寻址的是某个会话的发送意图；无会话的冷启动状态没有可寻址对象）。该意图是 ConversationController 上的按会话内存状态，经 conversation inject face 的 `hooks` 舱暴露给 Hero；它刻意不是持久化设置，因为这个选择只对正在启动的会话有意义。

勾选后，该会话的首次发送会在 `session.prompt` 上附加请求本地的 `newWorktree` 来源信息——与 `clientTimeZone` 相同的姿态：绝不属于会话、连接或 create 状态，因此 ACP/SDK 调用方与回放不受影响。不勾选的发送与今天的字节级一致。

### Host 迁移

在 `newWorktree: true` 且目标会话仍为空白（没有 `turn/start`）时，Host 迁移工作：解析会话 cwd，探测 `git rev-parse --show-toplevel`，找到仓库后从 toplevel 执行 `git worktree add -b wt-<timestamp> <parent>/<repo>.worktrees/wt-<timestamp>`。随后工作在一个在 该 worktree 中创建的新会话里开始（经 `ensureSession`，使用源会话解析出的组合、复制源会话当前模型选择），提示投递给该会话的 agent。响应经 `sessionId` 命名新会话。

新会话仍归属于**同一个**工作区，但直接 `attachSession` 会被拒绝：工作区成员关系要求会话的规范化 cwd 等于工作区路径（`sessionIds` 投影正是按这一事实过滤），而 worktree 是同级目录。因此工作区领域新增 **linked worktree 记账**：`Workspace.addWorktree(path)` 注册一个规范化目录（校验为已存在目录），它随后与工作区根一样参与成员关系——`attachSession` 接受 cwd 等于它的会话，`sessionIds` 取值器与持久化 prune 也包含它。迁移在源工作区上先 `addWorktree(worktreePath)`，再 `attachSession(newSessionId)`，于是 worktree 会话留在原始侧边栏分组里，而不是新建一个分组。没有注册工作区的松散源会话则保持 Ungrouped。

活跃会话的页头会在预设标签旁显示一个小 worktree 分支 chip：ui-conversation 的页头操作项（纯展示）从会话行的 `cwd` 派生——`.worktrees/<branch>` 布局——让用户总能看清会话运行在哪个 worktree，而无需新增工作区分组。

迁移采用全新会话身份，因为 session header 不可变；源会话的日志从未被触碰，因此它保持空白、隐藏、可被 New Session 复用。客户端跟随响应：运行时 Session 经新的 `onMoved` 选项通知 manager，manager 同步合入新列表行（`host/session-added` 帧与这次本地插入竞速；只填充字段的 upsert 合并让两种先后顺序都收敛）并转移选中项。源会话刻意不触发 `onEngaged`——把它翻成非空白会让一个空会话永远显示在列表里。

### 失败与忽略语义

cwd 不在任何 git 仓库内（包括 git 缺失或不可用）时忽略该标记并就地投递，与标记缺省完全一致——复选框可以跨工作区一直开着。非空白会话同样忽略：该标记是"在新 worktree 中开始"的意图，绝非会话中途迁移，且无论客户端自认为状态如何，Host 的空白判定都是权威。仓库检查通过之后 git 失败，或在创建出的 worktree 中启动会话失败，会以新的 `worktree-failed` 错误码拒绝整条提示（工作区附挂失败保留既有 `workspace-attach-failed` 语义），没有任何内容到达模型——用户明确要求 worktree 之后静默地在主树里工作，是错误的结果。

### 验证

git 模块的单元覆盖在临时目录里使用真实仓库：toplevel 探测、仓库外返回 null、在 HEAD 上创建同级路径与分支、多次调用生成不同标记。Host 代理覆盖用假 agent 工厂端到端驱动 `session.prompt`：迁移会创建 worktree 会话并把提示投递给它、源保持不动；非仓库与非空白会话忽略标记；worktree 父目录被占用时在发送任何内容之前以 `worktree-failed` 拒绝。客户端覆盖固定了负载来源信息、`onMoved` 约定（源不翻空白位）、manager 的合入与选中转移、Hero 复选框的渲染与切换，以及发送路径把意图变成发送选项。

## 已考虑的替代方案

**修改运行中会话的 header cwd。** 否决：`SessionHeader` 是深冻结的创建元数据，存储后端以它为目录键；一个修改 API 会与所有 cwd 消费方及持久格式相抵触。

**在会话创建／工作区选择时创建 worktree。** 否决：复选框位于一个已经创建的空白会话上，而且勾选即创建（尚未有任何工作）会为那些勾选后并没有发送消息的用户留下孤儿 worktree。工作的实际开始才是提交点。

**在提示之前经独立的 `createWorktree` RPC 在客户端完成。** 否决：它把一个意图拆成两个 RPC，让非浏览器调用方可以绕过或使配对失步，而且仍然需要同样的 host 侧会话创建。prompt 响应中的 `sessionId` 保持一次往返、一个权威。

**把该标记做成持久会话状态。** 否决：这个选择是按次发送的来源信息，在第一轮之后没有任何意义；请求本地字段让 create/resume/fork 状态与回放不受影响。

## 后果

worktree 目录与分支是 Host 在没有确认步骤的情况下创建的用户可见文件系统／git 状态；删除它们就是普通的 `git worktree remove`／`git branch -d`，Host 不追踪也不清理。每次迁移会在源工作区注册一个 linked worktree 路径（同级 worktree 从不在工作区根之下，因此成员关系必须有领域内的 linked worktree 记账）；该路径在工作区存续期间保持链接，只能通过修改持久化工作区记录来移除。worktree 会话与源会话出现在同一边侧栏分组里，靠页头分支 chip 而非新分组加以区分。被迁移走的空白会话仍留在 store 中；如果用户导航回它并带着仍然勾选的复选框再次发送，会得到又一个全新 worktree——这是文档化的"总是"语义，不是泄漏。`worktree-failed` 错误码加入封闭的 `RpcErrorDetailsMap`，因此新的 carrier 必须携带其 details 形状。
