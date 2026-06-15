<script setup lang="ts">
import { watch, nextTick, ref } from 'vue';
import { TerminalIcon, XIcon } from 'lucide-vue-next';
import WeshTerminalPane from '@/features/wesh-terminal/components/WeshTerminalPane.vue';
import { useChatWeshTerminalSessions } from '@/composables/useChatWeshTerminalSessions';
import { useConfirm } from '@/composables/useConfirm';
import type { ChatGroupId, ChatId } from '@/models/ids';
import type { Mount } from '@/models/types';
import type { NaidanSysfsAccessScope } from '@/services/wesh/types';

const props = defineProps<{
  isOpen: boolean;
  chatMounts: readonly Mount[] | undefined;
  chatGroupMounts: readonly Mount[] | undefined;
  chatId: ChatId | undefined;
  chatGroupId: ChatGroupId | undefined;
  naidanSysfsAccessScope: NaidanSysfsAccessScope;
}>();
const emit = defineEmits<{ (e: 'close'): void }>();

const {
  sessions,
  activeSessionId,
  runCommand,
  completeInput,
  cancelRunningCommand,
  closeSession,
  createChatWorkerSession,
  reopenSessionIfNeeded,
} = useChatWeshTerminalSessions();
const { showConfirm } = useConfirm();

const paneRef = ref<InstanceType<typeof WeshTerminalPane> | null>(null);

watch(() => props.isOpen, async (open) => {
  if (!open) return;
  await reopenSessionIfNeeded({
    chatMounts: props.chatMounts ?? [],
    chatGroupMounts: props.chatGroupMounts,
    chatId: props.chatId,
    chatGroupId: props.chatGroupId,
    naidanSysfsAccessScope: props.naidanSysfsAccessScope,
  });
  await nextTick();
  paneRef.value?.focusInput();
}, { immediate: true });

async function handleCloseSession({ sessionId }: { sessionId: string }) {
  const confirmed = await showConfirm({
    title: 'Close Session?',
    message: 'This will dispose the worker and lose the session history. Continue?',
    confirmButtonText: 'Close Session',
    cancelButtonText: 'Cancel',
    confirmButtonVariant: 'danger',
  });
  if (!confirmed) return;
  await closeSession({ sessionId });
}


defineExpose({
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  }
});
</script>

<template>
  <Transition name="modal">
    <div
      v-if="isOpen"
      class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50"
    >
      <div
        class="w-full max-w-4xl h-[85vh] flex flex-col rounded-2xl overflow-hidden border border-gray-700 shadow-2xl bg-gray-950"
      >
        <!-- Header -->
        <div class="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-gray-700/60 shrink-0">
          <div class="flex items-center gap-2">
            <TerminalIcon class="w-4 h-4 text-blue-500 shrink-0" />
            <span class="font-mono text-sm font-bold text-gray-200">Wesh Terminal</span>
          </div>
          <button
            class="p-1 rounded-lg hover:bg-gray-800 transition-colors text-gray-500 hover:text-gray-300"
            aria-label="Close terminal"
            @click="emit('close')"
          >
            <XIcon class="w-4 h-4" />
          </button>
        </div>

        <!-- Terminal pane fills remaining space -->
        <WeshTerminalPane
          ref="paneRef"
          class="flex-1 min-h-0 flex flex-col"
          :sessions="sessions"
          :active-session-id="activeSessionId"
          :complete-input="completeInput"
          @update:active-session-id="(id) => (activeSessionId = id)"
          @run="({ script }) => runCommand({ script })"
          @create-session="createChatWorkerSession({ chatMounts: chatMounts ?? [], chatGroupMounts, chatId, chatGroupId, naidanSysfsAccessScope })"
          @close-session="handleCloseSession"
          @cancel="({ sessionId }) => cancelRunningCommand({ sessionId })"
        />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.2s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
</style>
