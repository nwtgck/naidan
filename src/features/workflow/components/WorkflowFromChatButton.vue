<script setup lang="ts">
import { ref, toRaw, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import type { MessageNode } from '@/01-models/types';
import type { resolveChatSettings } from '@/logic/chat-settings-resolver';
import { storageService } from '@/00-storage/service';
import { useConfirm } from '@/composables/useConfirm';
import { ensureStrings, lazyStrings } from '@/strings';
import { copyChatMessage } from '@/01-models/chat-message';
import { cloneEndpoint } from '@/01-models/endpoint';

const props = defineProps<{
  messages: readonly MessageNode[],
  settings: ReturnType<typeof resolveChatSettings> | null | undefined,
  title: string | null | undefined,
  disabled: boolean,
}>();
const { showConfirm } = useConfirm();
const router = useRouter();
const busy = ref(false), error = ref('');
let controller: AbortController | undefined;
onBeforeUnmount(() => controller?.abort());

async function copy(): Promise<void> {
  if (busy.value || props.disabled || !props.settings) {
    return;
  }
  const settings = props.settings, messages = props.messages;
  const snapshot = messages.map(message => copyChatMessage({ message }));
  const resolved = {
    endpoint: cloneEndpoint({ endpoint: settings.endpoint }),
    modelId: settings.modelId ?? '',
    lmParameters: structuredClone(toRaw(settings.lmParameters)),
    systemPrompts: [...settings.systemPromptMessages],
  };
  const title = props.title ?? '';
  busy.value = true;
  error.value = '';
  controller = new AbortController();
  const signal = controller.signal;
  try {
    if (!await showConfirm({ message: await ensureStrings.workflow__conversation_import_help() }) || props.disabled || settings !== props.settings || messages !== props.messages || signal.aborted) {
      return;
    }
    const { workflowFromChat } = await import('@/features/workflow/logic/chat-transfer');
    const { useWorkflowWorkspace } = await import('@/features/workflow/composables/use-workflow-workspace');
    signal.throwIfAborted();
    const inputLabel = await ensureStrings.workflow__input_response();
    const definition = await workflowFromChat({
      messages: snapshot,
      title,
      ...resolved,
      inputLabel,
      signal,
      readBinaryObject: async ({ id, signal }) => {
        signal.throwIfAborted();
        return storageService.getFile({ binaryObjectId: id });
      },
    });
    signal.throwIfAborted();
    if (props.disabled || messages !== props.messages || settings !== props.settings) {
      return;
    }
    if (await useWorkflowWorkspace().importDefinition({ next: definition, canApply: () => !signal.aborted && !props.disabled && messages === props.messages && settings === props.settings }) && !signal.aborted) {
      await router.push('/workflows');
    }
  } catch (reason) {
    if (!signal.aborted) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    busy.value = false;
  }
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>
<template>
  <div tw-class="px-4 py-1 text-right">
    <button type="button" :disabled="disabled || busy || !settings || !messages.length" @click="copy" data-testid="chat-copy-to-workflow" tw-class="rounded-lg px-3 py-2 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-40">{{ lazyStrings.workflow__copy_to_workflow() }}</button>
    <p v-if="error" role="alert" tw-class="text-xs text-red-600 dark:text-red-400 break-words">{{ error }}</p>
  </div>
</template>
