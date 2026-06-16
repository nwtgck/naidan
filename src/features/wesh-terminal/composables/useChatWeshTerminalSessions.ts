import { createWeshTerminalSessions } from '@/features/wesh-terminal/composables/useWeshTerminalSessions'
import type { ChatGroupId, ChatId } from '@/models/ids'
import type { Mount } from '@/models/types'
import { buildWorkerMountsForChat } from '@/services/wesh/chat-worker-mounts'
import type { NaidanSysfsAccessScope } from '@/services/wesh/types'

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
  chatId: ChatId | undefined
  chatGroupId: ChatGroupId | undefined
  naidanSysfsAccessScope: NaidanSysfsAccessScope
}

function buildMountsForSession({
  chatMounts,
  chatGroupMounts,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
}: SessionArgs) {
  return buildWorkerMountsForChat({
    chatMounts,
    chatGroupMounts,
    chatId,
    chatGroupId,
    naidanSysfsAccessScope,
  })
}

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }: SessionArgs) =>
      store.createSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }) }),
    ensureActiveSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }) }),
    reopenSessionIfNeeded: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }) }),
    TEST_ONLY: {
      buildWorkerMountsForChat,
    },
  }
}
