<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import { Loader2Icon } from 'lucide-vue-next';
import type { ChatGroup } from '@/01-models/types';
import { useChatGroupName } from '@/composables/chat/ui/useChatGroupName';
import { useLayout } from '@/composables/useLayout';
import { lazyStrings } from '@/strings';

const props = defineProps<{
  chatGroup: Pick<ChatGroup, 'id' | 'name'>,
  restoreFocusTo: HTMLElement | undefined,
}>();
const emit = defineEmits<{ (e: 'close'): void }>();
const { renameChatGroup, isRenamingChatGroup } = useChatGroupName();
const { activeFocusArea, setActiveFocusArea } = useLayout();
const previousFocusArea = activeFocusArea.value;
const restoreFocusTo = props.restoreFocusTo;
const chatGroupId = props.chatGroup.id;
const originalName = props.chatGroup.name;
const name = ref(originalName);
const state = ref<'editing' | 'saving'>('editing');
const error = ref<'none' | 'failed'>('none');
const composition = ref<'idle' | 'composing'>('idle');
const dialog = ref<HTMLElement>();
const input = ref<HTMLInputElement>();
const headingId = useId();
const inputId = useId();
const errorId = useId();
const isSaving = computed(() => {
  const value = state.value;
  switch (value) {
  case 'editing': return false;
  case 'saving': return true;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled rename state: ${_ex}`);
  }
  }
});
const canSave = computed(() => !isSaving.value && !isRenamingChatGroup({ chatGroupId }) && name.value.trim() !== '' && name.value.trim() !== originalName);

onMounted(() => {
  setActiveFocusArea({ area: 'dialog' });
  input.value?.focus();
  input.value?.select();
});

onUnmounted(() => {
  const area = activeFocusArea.value;
  switch (area) {
  case 'dialog':
    setActiveFocusArea({ area: previousFocusArea });
    if (restoreFocusTo?.isConnected) {
      restoreFocusTo.focus();
    }
    return;
  case 'sidebar':
  case 'chat':
  case 'chat-group-settings':
  case 'chat-settings':
  case 'settings':
  case 'onboarding':
  case 'none':
  case 'search':
    return;
  default: {
    const _ex: never = area;
    throw new Error(`Unhandled focus area: ${_ex}`);
  }
  }
});

function closeDialog() {
  if (!isSaving.value) {
    emit('close');
  }
}

async function saveName() {
  if (!canSave.value) {
    return;
  }
  const newName = name.value.trim();
  state.value = 'saving';
  error.value = 'none';
  try {
    if (await renameChatGroup({ chatGroup: { id: chatGroupId, name: originalName }, newName, source: 'manual' })) {
      emit('close');
    }
  } catch {
    error.value = 'failed';
  } finally {
    state.value = 'editing';
  }
}

function handleKeydown({ event }: { event: KeyboardEvent }) {
  if (event.key === 'Tab') {
    const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('input, button') ?? [])].filter(control => !control.matches(':disabled'));
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
    return;
  }
  if (event.isComposing || event.keyCode === 229 || composition.value === 'composing') {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDialog();
  } else if (event.key === 'Enter' && event.target === input.value) {
    event.preventDefault();
    void saveName();
  }
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {},
  }) || {}),
});
</script>

<template>
  <Teleport to="body">
    <div
      tw-class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4 backdrop-blur-[2px]"
      @click.self="closeDialog"
      @keydown.stop="handleKeydown({ event: $event })"
      data-testid="chat-group-name-dialog"
    >
      <div ref="dialog" role="dialog" aria-modal="true" :aria-labelledby="headingId" :aria-busy="isSaving" tw-class="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <h2 :id="headingId" tw-class="text-base font-semibold text-gray-900 dark:text-gray-100">{{ lazyStrings.ChatGroupNameDialog__rename_chat_group() }}</h2>
        <label :for="inputId" tw-class="mb-2 mt-5 block text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.ChatGroupNameDialog__group_name() }}</label>
        <input
          :id="inputId"
          ref="input"
          v-model="name"
          type="text"
          :readonly="isSaving"
          :aria-describedby="error === 'failed' ? errorId : undefined"
          tw-class="w-full rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-400/60 focus:ring-2 focus:ring-blue-400/20 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
          @compositionstart="composition = 'composing'"
          @compositionend="composition = 'idle'"
          data-testid="chat-group-name-input"
        />
        <p v-if="error === 'failed'" :id="errorId" role="alert" tw-class="mt-2 text-xs leading-5 text-red-600 dark:text-red-400" data-testid="chat-group-name-error">{{ lazyStrings.ChatGroupNameDialog__failed_to_rename_chat_group() }}</p>
        <div tw-class="mt-5 flex items-center justify-end gap-2">
          <button type="button" :disabled="isSaving" @click="closeDialog" tw-class="min-h-9 rounded-lg px-3 text-sm text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200" data-testid="chat-group-name-cancel">{{ lazyStrings.SHARED__cancel() }}</button>
          <button type="button" :disabled="!canSave" @click="saveName" tw-class="inline-flex min-h-9 items-center justify-center gap-2 rounded-lg border border-gray-900 bg-gray-900 px-4 text-sm font-medium text-white transition-colors hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/40 disabled:border-gray-200 disabled:bg-gray-100 disabled:text-gray-400 dark:border-gray-600 dark:bg-gray-700 dark:hover:bg-gray-600 dark:disabled:border-gray-700 dark:disabled:bg-gray-800 dark:disabled:text-gray-500" data-testid="chat-group-name-save"><Loader2Icon v-if="isSaving" tw-class="h-4 w-4 animate-spin" />{{ isSaving ? lazyStrings.ChatGroupNameDialog__saving() : lazyStrings.ChatGroupNameDialog__save() }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
