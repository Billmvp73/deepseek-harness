/**
 * Git worktree creation behind `session.prompt`'s request-local
 * `newWorktree` flag. A cwd outside any repository resolves to `null` so the
 * caller can ignore the flag exactly like an absent one.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** One freshly created linked worktree of the repository owning a session cwd. */
export interface CreatedWorktree {
  /** Absolute path of the new worktree directory. */
  readonly path: string
  /** Name of the new branch checked out in {@link path}. */
  readonly branch: string
  /** Absolute path of the source repository toplevel. */
  readonly repoPath: string
}

/** Collision-free suffix shared by the branch and directory names. */
function worktreeStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear()).padStart(4, '0')}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `wt-${stamp}-${randomUUID().slice(0, 8)}`
}

/** Run one git command in `cwd`, rejecting with git's stderr. */
function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = stderr.trim()
        reject(new Error(detail === '' ? error.message : `git ${String(args[0])}: ${detail}`, { cause: error }))
        return
      }
      resolve(stdout.trim())
    })
  })
}

/**
 * Resolve the repository toplevel containing `cwd`.
 * @param cwd - directory to probe.
 * @returns the toplevel path, or `null` when the directory is not in a usable repository.
 */
export async function gitWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    return await git(['rev-parse', '--show-toplevel'], cwd)
  } catch {
    return null
  }
}

/**
 * Create a linked worktree on a new branch at the repository's current HEAD.
 * @param cwd - directory inside the repository to branch from.
 * @param now - clock used for the directory and branch stamp.
 * @returns the created worktree, or `null` outside a repository.
 */
export async function createGitWorktree(cwd: string, now: Date = new Date()): Promise<CreatedWorktree | null> {
  const root = await gitWorktreeRoot(cwd)
  if (root === null) return null
  const stamp = worktreeStamp(now)
  const path = join(dirname(root), `${basename(root)}.worktrees`, stamp)
  await git(['worktree', 'add', '-b', stamp, path], root)
  return { path, branch: stamp, repoPath: root }
}

/**
 * Best-effort rollback of a failed relocation: force-remove the created
 * worktree directory and delete its branch, so an aborted prompt does not
 * leave orphaned git state (a directory plus a branch pointing at HEAD)
 * behind on the user's machine.
 * @param worktree - the worktree {@link createGitWorktree} returned.
 * @throws when git cannot remove the directory or delete the branch; callers
 *   log this cleanup failure separately from the refusal that triggered it.
 */
export async function removeGitWorktree(worktree: CreatedWorktree): Promise<void> {
  await git(['worktree', 'remove', '--force', worktree.path], worktree.repoPath)
  await git(['branch', '-D', worktree.branch], worktree.repoPath)
}
