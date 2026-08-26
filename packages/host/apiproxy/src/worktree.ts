/**
 * Git worktree creation behind `session.prompt`'s request-local
 * `newWorktree` flag: before a blank session's first turn runs, the Host
 * relocates the work into a fresh linked worktree of the repository owning
 * the session cwd. Detection and creation both shell out to the user's `git`;
 * a cwd outside any repository resolves to `null` so the caller can ignore
 * the flag exactly like an absent one.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** One freshly created linked worktree of the repository owning a session cwd. */
export interface CreatedWorktree {
  /** Absolute path of the new worktree directory (created by `git worktree add`). */
  readonly path: string
  /** Name of the new branch `git worktree add -b` checked out in {@link path}. */
  readonly branch: string
  /** Absolute path of the repository toplevel the worktree branches from. */
  readonly repoPath: string
}

/** Collision-free `wt-<timestamp>-<short random>` suffix shared by the branch and directory names. */
function worktreeStamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear()).padStart(4, '0')}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `wt-${stamp}-${randomUUID().slice(0, 8)}`
}

/** Run one git command in `cwd`, rejecting with a message that carries git's stderr. */
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
 * @returns the toplevel path, or `null` when `cwd` is not inside a git
 *   repository (including a missing or unusable `git` binary — the caller
 *   treats both as "the new-worktree flag does not apply here").
 */
export async function gitWorktreeRoot(cwd: string): Promise<string | null> {
  try {
    return await git(['rev-parse', '--show-toplevel'], cwd)
  } catch {
    return null
  }
}

/**
 * Create a linked worktree of the repository containing `cwd`, checked out
 * on a new branch at the current HEAD. The worktree directory is a sibling
 * of the repository: `<parent>/<repo>.worktrees/<stamp>`.
 * @param cwd - directory inside the repository to branch from.
 * @param now - clock for the directory and branch stamp; defaults to now.
 * @returns the created worktree, or `null` when `cwd` is not inside a git
 *   repository (the caller ignores the relocation like an absent flag).
 * @throws when git itself fails (dirty state is irrelevant — the worktree
 *   branches from HEAD — but an unwritable parent or a broken repository
 *   surfaces verbatim).
 */
export async function createGitWorktree(cwd: string, now: Date = new Date()): Promise<CreatedWorktree | null> {
  const root = await gitWorktreeRoot(cwd)
  if (root === null) return null
  const stamp = worktreeStamp(now)
  const branch = stamp
  const path = join(dirname(root), `${basename(root)}.worktrees`, stamp)
  await git(['worktree', 'add', '-b', branch, path], root)
  return { path, branch, repoPath: root }
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
