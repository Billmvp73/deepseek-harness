import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGitWorktree, gitWorktreeRoot } from '../src/worktree.ts'

const run = promisify(execFile)

/** One real git repository in a temp dir (the module shells out to the user's git). */
async function initRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worktree-'))
  const repo = join(root, 'repo')
  await mkdir(repo)
  const git = (args: string[]): Promise<unknown> => run('git', ['-C', repo, ...args])
  await git(['init', '-b', 'main'])
  await git(['config', 'user.email', 'test@example.com'])
  await git(['config', 'user.name', 'test'])
  await writeFile(join(repo, 'file.txt'), 'hello\n')
  await git(['add', 'file.txt'])
  await git(['commit', '-m', 'init'])
  return repo
}

describe('gitWorktreeRoot', () => {
  const roots: string[] = []

  beforeAll(async () => {
    roots.push(await initRepo())
  })

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  })

  it('resolves the toplevel for a path inside a repository', async () => {
    const repo = roots[0]!
    expect(await gitWorktreeRoot(repo)).toBe(await run('git', ['-C', repo, 'rev-parse', '--show-toplevel'])
      .then(r => r.stdout.trim()))
  })

  it('reports null outside any repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-worktree-plain-'))
    roots.push(plain)
    expect(await gitWorktreeRoot(plain)).toBeNull()
  })
})

describe('createGitWorktree', () => {
  const roots: string[] = []

  afterAll(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true })
  })

  it('returns null for a cwd outside any repository', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'dsh-worktree-plain-'))
    roots.push(plain)
    expect(await createGitWorktree(plain)).toBeNull()
  })

  it('creates a sibling worktree on a fresh branch at HEAD', async () => {
    const repo = await initRepo()
    roots.push(join(repo, '..'))
    const worktree = await createGitWorktree(repo)
    expect(worktree).not.toBeNull()
    // Compare against git's own toplevel: temp dirs may resolve through 8.3
    // short names, and git reports the canonical long path.
    const toplevel = await run('git', ['-C', repo, 'rev-parse', '--show-toplevel']).then(r => r.stdout.trim())
    expect(worktree!.path.startsWith(join(dirname(toplevel), `${basename(toplevel)}.worktrees`))).toBe(true)
    // The new worktree resolves to itself and carries the repo's file at HEAD.
    expect(await run('git', ['-C', worktree!.path, 'rev-parse', '--show-toplevel']).then(r => r.stdout.trim()))
      .toBe(worktree!.path.replaceAll('\\', '/'))
    expect(await run('git', ['-C', worktree!.path, 'status', '--porcelain']).then(r => r.stdout.trim())).toBe('')
    // The new branch exists in the source repository and is checked out in the worktree.
    expect(worktree!.branch).toMatch(/^wt-\d{8}-\d{6}-[0-9a-f]{8}$/)
    expect(await run('git', ['-C', repo, 'branch', '--list', worktree!.branch]).then(r => r.stdout))
      .toContain(worktree!.branch)
    expect(await run('git', ['-C', worktree!.path, 'rev-parse', '--abbrev-ref', 'HEAD']).then(r => r.stdout.trim()))
      .toBe(worktree!.branch)
  })

  it('mints distinct paths and branches across repeated calls', async () => {
    const repo = await initRepo()
    roots.push(join(repo, '..'))
    const first = await createGitWorktree(repo)
    const second = await createGitWorktree(repo)
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second!.path).not.toBe(first!.path)
    expect(second!.branch).not.toBe(first!.branch)
  })
})
