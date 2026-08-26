/**
 * `session.prompt`'s request-local `newWorktree` relocation: a blank session
 * in a git repository starts its first turn inside a freshly created linked
 * worktree (a new session in its own registered workspace, delivered
 * message), a cwd outside any repository ignores the flag, a non-blank
 * session ignores it, and a git failure after the repository check rejects
 * with `worktree-failed`.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const run = promisify(execFile)

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`worktree-${String(nextRpc++)}`), payload }
}

class SilentAdapter extends LlmAdapter {
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly never[]> {
    return Promise.resolve([])
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    // The relocated turn only needs to start; no model output is asserted.
  }
}

interface FakeWorkspace {
  id: string
  path: string
  title: string
  sessionIds: SessionId[]
  worktreePaths: string[]
  attachSession: (sessionId: SessionId) => Promise<void>
  addWorktree: (path: string) => Promise<void>
}

async function harness(cwd: string, faults: {
  /** The agent factory's create rejects (the worktree session cannot start). */
  failCreate?: boolean
  /** Workspace attachment rejects after the relocation session is published. */
  failAttach?: boolean
  /** The workspace registry's list throws (workspace resolution fails). */
  throwWorkspaceList?: boolean
  /** The relocated agent's followup rejects (post-relocation admission failure). */
  failFollowup?: boolean
} = {}): Promise<{
  ctx: Context
  sessionId: SessionId
  agent: Agent
  followup: ReturnType<typeof vi.fn>
  movedFollowup: ReturnType<typeof vi.fn>
  workspaces: FakeWorkspace[]
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.llm.registerAdapter(['deepseek-official'], new SilentAdapter())
  const session = ctx.sessions.create(SessionId(`session-${String(nextRpc++)}`), { meta: { cwd } })
  const followup = vi.fn()
  const movedFollowup = vi.fn()
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  Object.assign(agent, { followup })
  ctx.agents.register(agent)
  // Minimal agent factory: the relocation path only needs the new session +
  // a registered agent whose delivery verb is observable; the loop never runs.
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
      if (faults.failCreate === true) throw new Error('factory refused the relocation session')
      const created = ownerCtx.sessions.create(options.sessionId, {
        ...(options.meta === undefined ? {} : { meta: options.meta }),
        ...(options.seed === undefined ? {} : { seed: [...options.seed] }),
      })
      const createdAgent = {
        id: created.id,
        session: created,
        status: 'idle',
        ctx: ownerCtx,
        inbox: { nextTurn: [], nextStep: [] },
      } as unknown as Agent
      const createdFollowup = faults.failFollowup === true
        ? (): never => { throw new Error('agent busy') }
        : movedFollowup
      Object.assign(createdAgent, { followup: createdFollowup, steer: vi.fn(), cancel: vi.fn() })
      ownerCtx.agents.register(createdAgent)
      return { agent: createdAgent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('resume is not used in this harness')),
  })
  // One source workspace: the worktree session must join THIS workspace (not a
  // new one) once `addWorktree` registers the linked path.
  const source: FakeWorkspace = {
    id: 'ws-1', path: cwd, title: basename(cwd), sessionIds: [session.id], worktreePaths: [],
    attachSession: faults.failAttach === true
      ? () => Promise.reject(new Error('workspace attach refused'))
      : vi.fn(),
    addWorktree: (path: string) => {
      if (!source.worktreePaths.includes(path)) source.worktreePaths.push(path)
      return Promise.resolve()
    },
  }
  const workspaces: FakeWorkspace[] = [source]
  ctx.provide('workspaceRegistry', {
    list: faults.throwWorkspaceList === true
      ? () => { throw new Error('workspace registry offline') }
      : () => workspaces,
  } as never)
  return { ctx, sessionId: session.id, agent, followup, movedFollowup, workspaces }
}

async function initRepo(withCommit: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-worktree-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  const git = (args: string[]): Promise<unknown> => run('git', ['-C', repo, ...args])
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'test'])
  if (withCommit) {
    await run('git', ['-C', repo, '-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'])
  }
  return repo
}

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

describe('session.prompt newWorktree relocation', () => {
  it('moves a blank session first prompt into a fresh worktree session', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    const { ctx, sessionId, followup, movedFollowup, workspaces } = await harness(repo)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    if (!response.result.ok) throw new Error(response.result.error.message)
    const movedTo = response.result.value.sessionId
    expect(movedTo).toBeDefined()
    expect(movedTo).not.toBe(sessionId)
    const moved = ctx.sessions.get(movedTo!)
    expect(moved).toBeDefined()
    // The new session lives in a sibling worktree of the source repository
    // (compared against git's own toplevel: temp dirs may resolve through
    // 8.3 short names, and git reports the canonical long path).
    const movedCwd = moved!.header.cwd
    expect(movedCwd).toBeDefined()
    const toplevel = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel']).then(r => r.stdout.trim())
    expect(movedCwd!.startsWith(join(dirname(toplevel), `${basename(toplevel)}.worktrees`, 'wt-'))).toBe(true)
    // The exact prompt was delivered to the NEW session's agent, and the
    // source agent and log were never touched (it stays blank and reusable).
    expect(movedFollowup).toHaveBeenCalledOnce()
    expect((movedFollowup.mock.calls[0]?.[0] as { content: { type: string; text?: string }[] }).content)
      .toEqual([{ type: 'text', text: '开工' }])
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.sessions.get(sessionId)!.events).toHaveLength(0)
    // The worktree session joined the SAME workspace as its source (no new
    // sidebar group): the source workspace registered the worktree as a
    // linked path, then accounted the relocated session.
    expect(workspaces).toHaveLength(1)
    const source = workspaces[0]!
    expect(source.worktreePaths).toEqual([movedCwd])
    expect(source.attachSession).toHaveBeenCalledWith(movedTo)
  }, 20_000)

  it('ignores the flag outside a git repository and prompts in place', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-api-worktree-plain-'))
    roots.push(plain)
    const { ctx, sessionId, followup } = await harness(plain)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(response.result.ok ? response.result.value.sessionId : undefined).toBeUndefined()
    expect(followup).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('ignores the flag on a non-blank session', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    const { ctx, sessionId, followup } = await harness(repo)
    ctx.sessions.get(sessionId)!.append('turn/start', { turn: 1 })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '继续' }], newWorktree: true,
    }))
    expect(response.result).toMatchObject({ ok: true, value: { accepted: true } })
    expect(response.result.ok ? response.result.value.sessionId : undefined).toBeUndefined()
    expect(followup).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('rejects with worktree-failed when git cannot create the worktree', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    // The worktree parent name is occupied by a file, so `git worktree add`
    // fails after `rev-parse --show-toplevel` proved this is a repository.
    await writeFile(join(repo, '..', `${basename(repo)}.worktrees`), 'occupied')
    const { ctx, sessionId, followup } = await harness(repo)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'worktree-failed' } })
    // Nothing reached the model and no relocation session was published.
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.sessions.list()).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('rejects with worktree-failed when the worktree session cannot start', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    const { ctx, sessionId, followup } = await harness(repo, { failCreate: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    // The worktree was created on disk but no session could start in it; the
    // error names both and nothing reached the model. The failed relocation
    // must not leave orphaned git state: the worktree directory and its
    // wt-* branch are rolled back before the refusal surfaces.
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected failure')
    const error = response.result.error as { code: string; details: { cwd: string; worktree: string } }
    expect(error.code).toBe('worktree-failed')
    expect(error.details.cwd).toBe(repo)
    expect(error.details.worktree).toContain('wt-')
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.sessions.list()).toHaveLength(1)
    expect(existsSync(error.details.worktree)).toBe(false)
    const branches = await run('git', ['-C', repo, 'branch', '--list', 'wt-*'])
    expect(branches.stdout.trim()).toBe('')
    await ctx.fiber.dispose()
  }, 20_000)

  it('maps a workspace attachment failure onto workspace-attach-failed with the published id', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    const { ctx, sessionId } = await harness(repo, { failAttach: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected failure')
    const details = response.result.error.details as { sessionId: SessionId; workspaceId: string }
    expect(response.result.error).toMatchObject({
      code: 'workspace-attach-failed',
      details: { workspaceId: 'ws-1' },
    })
    // Publication precedes attachment: the relocation session exists, but the
    // caller still learns about the attachment failure instead of a silently
    // ungrouped move. The failed relocation rolls back too: no wt-* branch
    // survives, and the `.worktrees` parent holds no leftover worktrees
    // (git keeps the now-empty parent directory itself).
    expect(ctx.sessions.get(details.sessionId)).toBeDefined()
    expect(response.result.ok).toBe(false)
    const branches = await run('git', ['-C', repo, 'branch', '--list', 'wt-*'])
    expect(branches.stdout.trim()).toBe('')
    const parents = await readdir(join(repo, '..'))
    const leftoverEntries = (await Promise.all(parents
      .filter(name => name.startsWith(`${basename(repo)}.worktrees`))
      .map(name => readdir(join(repo, '..', name))))).flat()
    expect(leftoverEntries).toEqual([])
    await ctx.fiber.dispose()
  }, 20_000)

  it('rolls the worktree back when post-relocation admission refuses (agent-busy)', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    const { ctx, sessionId } = await harness(repo, { failFollowup: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    // Admission happens AFTER relocation succeeds, so this refusal path is the
    // ownership-transfer case: the worktree must still be rolled back.
    expect(response.result.ok).toBe(false)
    if (response.result.ok) throw new Error('expected failure')
    expect(response.result.error).toMatchObject({ code: 'agent-busy' })
    const branches = await run('git', ['-C', repo, 'branch', '--list', 'wt-*'])
    expect(branches.stdout.trim()).toBe('')
    const parents = await readdir(join(repo, '..'))
    const leftoverEntries = (await Promise.all(parents
      .filter(name => name.startsWith(`${basename(repo)}.worktrees`))
      .map(name => readdir(join(repo, '..', name))))).flat()
    expect(leftoverEntries).toEqual([])
    await ctx.fiber.dispose()
  }, 20_000)

  it('folds a workspace-resolution failure into an internal error', async () => {
    const repo = await initRepo(true)
    roots.push(join(repo, '..'))
    const { ctx, sessionId, followup } = await harness(repo, { throwWorkspaceList: true })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
      cwd: tmpdir(),
    })
    const response = await api.sessions.prompt(request({
      sessionId, mode: 'queue' as const, content: [{ type: 'text' as const, text: '开工' }], newWorktree: true,
    }))
    expect(response.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(followup).not.toHaveBeenCalled()
    // The workspace-resolution failure also rolls the worktree back: no
    // wt-* branch survives the refusal.
    const branches = await run('git', ['-C', repo, 'branch', '--list', 'wt-*'])
    expect(branches.stdout.trim()).toBe('')
    await ctx.fiber.dispose()
  }, 20_000)
})
