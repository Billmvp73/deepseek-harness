/**
 * The session header's worktree label: a small chip naming the git worktree
 * branch this session's cwd lives in, beside the agent-preset label.
 *
 * Derivation is presentation-only over the session row's `cwd`: when it ends
 * in a `<parent>/<repo>.worktrees/<branch>` path — the layout `session.prompt`'s
 * `newWorktree` relocation creates — the chip shows that branch segment. A
 * session whose cwd is not under a `.worktrees` directory renders nothing, so
 * ordinary workspace sessions stay unlabelled.
 */

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './ConversationRoot.module.css'

/** Full props composed from the header-actions slot contract. */
export type WorktreeLabelProps =
  PropsRuntime<'conversation.session.header.actions'>
  & PropsLocale<'conversation'>

/** The branch segment of a session cwd under a `<repo>.worktrees/<branch>` layout. */
function worktreeBranchOf(cwd: string): string | undefined {
  const match = /[\\/][^\\/]*\.worktrees[\\/]([^\\/]+)$/u.exec(cwd)
  return match?.[1]
}

/**
 * Render the worktree branch this session works in, or null when the session
 * does not run in a linked worktree.
 * @param props - composed slot props.
 * @returns the branch chip, or null when no worktree is detectable.
 */
export function WorktreeLabel({
  sessionId, useSessions, t,
}: WorktreeLabelProps) {
  const cwd = useSessions(state => state.byId[sessionId]?.cwd)
  const branch = cwd === undefined ? undefined : worktreeBranchOf(cwd)
  if (branch === undefined) return null
  return (
    <span className={css.worktreeLabel} title={cwd} aria-label={t('header.worktree', { branch })}>
      <IconBranchOutline16 size={14} className={css.worktreeIcon} />
      {branch}
    </span>
  )
}
