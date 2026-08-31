/** Session Remote coverage for first-prompt relocation into a new git worktree. */

import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote, type TestSessionRemote } from './test-remote.ts'

const run = promisify(execFile)
let nextRequestId = 1

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
    // Prompt admission is observed at the Agent inbox, before model streaming.
  }
}

interface FakeWorkspace {
  readonly id: string
  readonly path: string
  readonly title: string
  readonly sessionIds: SessionId[]
  readonly worktreePaths: string[]
  readonly attachSession: ReturnType<typeof vi.fn<(sessionId: SessionId) => Promise<void>>>
  readonly addWorktree: (path: string) => Promise<void>
}

interface Harness {
  readonly ctx: Context
  readonly remote: TestSessionRemote
  readonly sessionId: SessionId
  readonly followup: ReturnType<typeof vi.fn>
  readonly movedFollowup: ReturnType<typeof vi.fn>
  readonly workspace: FakeWorkspace
}

const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

function promptRequest(
  sessionId: SessionId,
  text: string,
): SessionPromptRequest {
  return {
    requestId: `worktree-${String(nextRequestId++)}` as SessionRequestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text }],
    newWorktree: true,
  }
}

async function harness(cwd: string, rejectMovedPrompt = false): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  ctx.llm.registerAdapter(['deepseek-official'], new SilentAdapter())

  const session = ctx.sessions.create(SessionId(`session-${String(nextRequestId++)}`), { meta: { cwd } })
  const followup = vi.fn()
  const movedFollowup = rejectMovedPrompt
    ? vi.fn(() => { throw new Error('relocated prompt refused') })
    : vi.fn()
  const agent = {
    id: session.id,
    session,
    status: 'idle',
    ctx,
    inbox: { nextTurn: [], nextStep: [] },
    followup,
  } as unknown as Agent
  ctx.agents.register(agent)
  ctx.agents.setFactory({
    createAgent: async (ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> => {
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
        followup: movedFollowup,
        steer: vi.fn(),
        cancel: vi.fn(),
      } as unknown as Agent
      ownerCtx.agents.register(createdAgent)
      return { agent: createdAgent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('resume is not used in this harness')),
  })

  const attachSession = vi.fn<(sessionId: SessionId) => Promise<void>>().mockResolvedValue(undefined)
  const workspace: FakeWorkspace = {
    id: 'ws-1',
    path: cwd,
    title: basename(cwd),
    sessionIds: [session.id],
    worktreePaths: [],
    attachSession,
    addWorktree: (path) => {
      if (!workspace.worktreePaths.includes(path)) workspace.worktreePaths.push(path)
      return Promise.resolve()
    },
  }
  ctx.provide('workspaceRegistry', { list: () => [workspace] } as never)
  const remote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }),
    cwd: tmpdir(),
  })
  return { ctx, remote, sessionId: session.id, followup, movedFollowup, workspace }
}

async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-api-worktree-'))
  roots.push(root)
  const repo = join(root, 'repo')
  await mkdir(repo)
  await run('git', ['-C', repo, 'init', '-b', 'main'])
  await run('git', [
    '-C', repo,
    '-c', 'user.email=test@example.com',
    '-c', 'user.name=test',
    'commit', '--allow-empty', '-m', 'init',
  ])
  return repo
}

function relocatedSession(ctx: Context, sourceId: SessionId) {
  return ctx.sessions.list().find(session => session.id !== sourceId)
}

describe('session.prompt newWorktree relocation', () => {
  it('moves a blank session first prompt into a fresh worktree session', async () => {
    const repo = await initRepo()
    const { ctx, remote, sessionId, followup, movedFollowup, workspace } = await harness(repo)

    const response = await remote.prompt(promptRequest(sessionId, '开工'))

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.value.sessionId).toBeDefined()
    expect(response.value.sessionId).not.toBe(sessionId)
    const moved = ctx.sessions.get(response.value.sessionId!)
    expect(moved).toBeDefined()
    const movedCwd = moved?.header.cwd
    expect(movedCwd).toBeDefined()
    const toplevel = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel']).then(result => result.stdout.trim())
    expect(movedCwd?.startsWith(join(dirname(toplevel), `${basename(toplevel)}.worktrees`, 'wt-'))).toBe(true)
    expect(movedFollowup).toHaveBeenCalledOnce()
    expect(movedFollowup.mock.calls[0]?.[0]).toMatchObject({
      content: [{ type: 'text', text: '开工' }],
      source: { kind: 'user' },
    })
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.sessions.get(sessionId)?.events).toHaveLength(0)
    expect(workspace.worktreePaths).toEqual([movedCwd])
    expect(workspace.attachSession).toHaveBeenCalledWith(response.value.sessionId)
  }, 20_000)

  it('ignores newWorktree outside a repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-api-worktree-plain-'))
    roots.push(plain)
    const { remote, sessionId, followup, movedFollowup } = await harness(plain)

    const response = await remote.prompt(promptRequest(sessionId, '开工'))

    expect(response).toEqual({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledOnce()
    expect(movedFollowup).not.toHaveBeenCalled()
  })

  it('ignores newWorktree for a nonblank session', async () => {
    const repo = await initRepo()
    const { ctx, remote, sessionId, followup, movedFollowup } = await harness(repo)
    ctx.sessions.get(sessionId)?.append('turn/start', { turn: 1 })

    const response = await remote.prompt(promptRequest(sessionId, '继续'))

    expect(response).toEqual({ ok: true, value: { accepted: true } })
    expect(followup).toHaveBeenCalledOnce()
    expect(movedFollowup).not.toHaveBeenCalled()
    expect(ctx.sessions.list()).toHaveLength(1)
  })

  it('reports git failure without publishing a relocation session', async () => {
    const repo = await initRepo()
    await writeFile(join(dirname(repo), `${basename(repo)}.worktrees`), 'occupied')
    const { ctx, remote, sessionId, followup } = await harness(repo)

    const response = await remote.prompt(promptRequest(sessionId, '开工'))

    expect(response).toMatchObject({ ok: false, error: { code: 'worktree-failed' } })
    expect(followup).not.toHaveBeenCalled()
    expect(ctx.sessions.list()).toHaveLength(1)
  })

  it('rolls back the worktree when the relocated prompt is rejected', async () => {
    const repo = await initRepo()
    const { ctx, remote, sessionId, followup, movedFollowup } = await harness(repo, true)

    const response = await remote.prompt(promptRequest(sessionId, '开工'))

    expect(response).toMatchObject({ ok: false, error: { code: 'agent-busy' } })
    expect(followup).not.toHaveBeenCalled()
    expect(movedFollowup).toHaveBeenCalledOnce()
    const moved = relocatedSession(ctx, sessionId)
    expect(moved).toBeDefined()
    const movedCwd = moved?.header.cwd
    expect(movedCwd).toBeDefined()
    await expect(access(movedCwd!)).rejects.toThrow()
    expect(await run('git', ['-C', repo, 'worktree', 'list', '--porcelain']).then(result => result.stdout))
      .not.toContain(movedCwd)
    const branch = basename(movedCwd!)
    expect(await run('git', ['-C', repo, 'branch', '--list', branch]).then(result => result.stdout.trim())).toBe('')
  }, 20_000)
})
