import { createWeshTerminalSessions } from '@/features/wesh-terminal/composables/useWeshTerminalSessions'
import type { Mount } from '@/models/types'
import { buildWorkerMountsForChat } from '@/services/wesh/chat-worker-mounts'
import type { NaidanSysfsMountSelection } from '@/services/wesh/types'

const store = createWeshTerminalSessions({
  opfsRootName: 'naidan-chat-wesh',
  user: 'user',
  initialEnv: { HOME: '/home/user', TMPDIR: '/tmp' },
  initialCwd: '/home/user',
  homeDirectory: '/home/user',
  tmpDirectory: '/tmp',
})

type SessionArgs = {
  chatMounts: readonly Mount[]
  chatGroupMounts: readonly Mount[] | undefined
  chatId: string | undefined
  chatGroupId: string | undefined
  naidanSysfsVisibility: NaidanSysfsMountSelection
}

function buildMountsForSession({
  chatMounts,
  chatGroupMounts,
  chatId,
  chatGroupId,
  naidanSysfsVisibility,
}: SessionArgs) {
  return buildWorkerMountsForChat({
    chatMounts,
    chatGroupMounts,
    chatId,
    chatGroupId,
    naidanSysfsVisibility,
  })
}

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }: SessionArgs) =>
      store.createSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }) }),
    ensureActiveSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }) }),
    reopenSessionIfNeeded: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }) }),
    TEST_ONLY: {
      buildWorkerMountsForChat,
    },
  }
}
