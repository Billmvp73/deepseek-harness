// @vitest-environment jsdom
// WorktreeLabel (session header actions): shows the linked worktree branch a
// session's cwd runs in, and renders nothing for ordinary workspace sessions.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, type SessionId, type SessionListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { WorktreeLabel, type WorktreeLabelProps } from '../src/client/skeleton/WorktreeLabel.tsx'
import { en, zh } from '../src/client/locales.ts'

const t: WorktreeLabelProps['t'] = makeTranslate(zh, commonZh)
const tEn: WorktreeLabelProps['t'] = makeTranslate(en, commonEn)

const sid = (id: string) => id as SessionId
const SID = sid('s1')

function sessions(cwd?: string): SessionListState {
  return {
    ids: cwd === undefined ? [] : [SID],
    byId: cwd === undefined
      ? {}
      : { [SID]: { id: SID, displayTitle: 's1', cwd, running: false, blank: false, updatedAt: 1 } },
    current: SID,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

function mount(cwd?: string) {
  const props = {
    sessionId: SID,
    useSessions: bindSnapshotSelector(createSnapshotStore(sessions(cwd))),
    t,
  } as unknown as WorktreeLabelProps
  return render(<WorktreeLabel {...props} />)
}

afterEach(() => { cleanup() })

describe('WorktreeLabel', () => {
  it('renders the worktree branch for a `.worktrees/<branch>` cwd', () => {
    const view = mount('C:\\projects\\deepseek-harness.worktrees\\wt-20260824-101112-abcd1234')
    expect(view.getByText('wt-20260824-101112-abcd1234')).toBeTruthy()
    expect(view.getByLabelText('此会话在此 worktree 分支中工作：wt-20260824-101112-abcd1234')).toBeTruthy()
  })

  it('renders nothing when the cwd is not under a `.worktrees` directory', () => {
    const view = mount('C:\\projects\\deepseek-harness')
    expect(view.container.firstChild).toBeNull()
  })

  it('renders nothing when the session carries no cwd', () => {
    const view = mount()
    expect(view.container.firstChild).toBeNull()
  })

  it('matches POSIX-style worktree paths too', () => {
    const view = mount('/home/u/repo.worktrees/wt-20260824-101112-abcd1234')
    expect(view.container.querySelector('[aria-label^="此会话在此 worktree"]')).not.toBeNull()
  })

  it('renders the English tooltip through the locale seat', () => {
    const props = {
      sessionId: SID,
      useSessions: bindSnapshotSelector(createSnapshotStore(sessions('/home/u/repo.worktrees/wt-x'))),
      t: tEn,
    } as unknown as WorktreeLabelProps
    const view = render(<WorktreeLabel {...props} />)
    expect(view.getByLabelText('This session works in the worktree branch wt-x')).toBeTruthy()
  })
})
