import { opfsFormat } from '@/00-format/01-layout/layout';
import { createWeshTerminalSessions } from '@/features/wesh-terminal/composables/useWeshTerminalSessions';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { Mount } from '@/01-models/types';
import { buildWorkerMountsForChat } from '@/features/wesh/chat-worker-mounts';
import type { NaidanSysfsAccessScope } from '@/features/wesh/types';

const { path: opfsPath, home: homeEntry, tmp: tmpEntry } = opfsFormat.chatWesh.global;
const home = '/' + homeEntry.path.slice(opfsPath.length).join('/');
const tmp = '/' + tmpEntry.path.slice(opfsPath.length).join('/');
const store = createWeshTerminalSessions({
  opfsPath,
  user: 'user',
  initialEnv: { HOME: home, TMPDIR: tmp },
  initialCwd: home,
  homeDirectory: home,
  tmpDirectory: tmp,
});

type SessionArgs = {
  chatMounts: readonly Mount[],
  chatGroupMounts: readonly Mount[] | undefined,
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
};

function buildMountsForSession({
  chatMounts,
  chatGroupMounts,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
}: { chatMounts: SessionArgs['chatMounts'], chatGroupMounts: SessionArgs['chatGroupMounts'], chatId: SessionArgs['chatId'], chatGroupId: SessionArgs['chatGroupId'], naidanSysfsAccessScope: SessionArgs['naidanSysfsAccessScope'] }) {
  return buildWorkerMountsForChat({
    chatMounts,
    chatGroupMounts,
    chatId,
    chatGroupId,
    naidanSysfsAccessScope,
  });
}

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }: { chatMounts: SessionArgs['chatMounts'], chatGroupMounts: SessionArgs['chatGroupMounts'], chatId: SessionArgs['chatId'], chatGroupId: SessionArgs['chatGroupId'], naidanSysfsAccessScope: SessionArgs['naidanSysfsAccessScope'] }) =>
      store.createSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }) }),
    ensureActiveSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }: { chatMounts: SessionArgs['chatMounts'], chatGroupMounts: SessionArgs['chatGroupMounts'], chatId: SessionArgs['chatId'], chatGroupId: SessionArgs['chatGroupId'], naidanSysfsAccessScope: SessionArgs['naidanSysfsAccessScope'] }) =>
      store.ensureSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }) }),
    reopenSessionIfNeeded: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }: { chatMounts: SessionArgs['chatMounts'], chatGroupMounts: SessionArgs['chatGroupMounts'], chatId: SessionArgs['chatId'], chatGroupId: SessionArgs['chatGroupId'], naidanSysfsAccessScope: SessionArgs['naidanSysfsAccessScope'] }) =>
      store.ensureSession({ buildMounts: () => buildMountsForSession({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope }) }),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        buildWorkerMountsForChat,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
