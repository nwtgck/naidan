<script setup lang="ts">
import { shallowRef, ref, watch, onBeforeUnmount, toRaw } from 'vue';
import { useRouter } from 'vue-router';
import type { TextOrBinaryObject } from '@/01-models/tool';
import type { ChatMessage } from '@/01-models/types';
import { idToRaw } from '@/01-models/ids';
import { useSettings } from '@/composables/useSettings';
import { useConfirm } from '@/composables/useConfirm';
import { cloneEndpoint } from '@/01-models/endpoint';
import { lazyStrings, ensureStrings } from '@/strings';
import type { WorkflowResultSource, WorkflowResultView } from '@/features/workflow/logic/result-view';

const props = defineProps<{ source: WorkflowResultSource }>();
const view = shallowRef<WorkflowResultView>();
const url = ref(''), error = ref(''), loading = ref(false), copying = ref(false);
const router = useRouter();
const { settings } = useSettings();
const { showConfirm } = useConfirm();
let controller: AbortController | undefined;
let generation = 0;

function close(): void {
  generation++;
  controller?.abort();
  controller = undefined;
  if (url.value) {
    URL.revokeObjectURL(url.value);
    url.value = '';
  }
  view.value = undefined;
  loading.value = false;
  error.value = '';
}

watch(() => props.source, close, { flush: 'sync' });
onBeforeUnmount(close);

async function load(): Promise<void> {
  if (loading.value) {
    return;
  }
  close();
  const observed = generation, source = props.source;
  controller = new AbortController();
  const signal = controller.signal;
  loading.value = true;
  try {
    const loaded = await source.load({ signal });
    if (signal.aborted || generation !== observed || source !== props.source) {
      return;
    }
    if (loaded.type === 'image' || loaded.type === 'audio') {
      url.value = URL.createObjectURL(loaded.blob);
    }
    view.value = loaded;
  } catch (reason) {
    if (!signal.aborted && generation === observed) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    if (generation === observed) {
      loading.value = false;
    }
  }
}

async function continueInChat(): Promise<void> {
  if (copying.value || view.value?.type !== 'conversation') {
    return;
  }
  const observed = generation;
  const messages = structuredClone(view.value.messages);
  const endpoint = cloneEndpoint({ endpoint: settings.value.endpoint });
  const modelId = settings.value.defaultModelId;
  const lmParameters = structuredClone(toRaw(settings.value.lmParameters));
  copying.value = true;
  try {
    if (!await showConfirm({ message: await ensureStrings.workflow__copy_conversation_notice() }) || generation !== observed) {
      return;
    }
    const { useChatLifecycle } = await import('@/composables/chat/ui/useChatLifecycle');
    if (generation !== observed) {
      return;
    }
    const chat = await useChatLifecycle().createChatFromHistory({ messages, endpoint, modelId, lmParameters });
    if (chat && generation === observed) {
      await router.push(`/chat/${encodeURIComponent(idToRaw({ id: chat.id }))}`);
    }
  } catch (reason) {
    if (generation === observed) {
      error.value = reason instanceof Error ? reason.message : String(reason);
    }
  } finally {
    copying.value = false;
  }
}

function storedText({ value }: { value: TextOrBinaryObject }): string | undefined {
  switch (value.type) {
  case 'text': return value.text;
  case 'binary_object': return lazyStrings.workflow__result_unavailable();
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
}

function partText({ part }: { part: ChatMessage['parts'][number] }): string | undefined {
  switch (part.type) {
  case 'text': case 'reasoning': return part.text;
  case 'tool_call': return `${part.toolCall.function.name}\n${part.toolCall.function.arguments}`;
  case 'tool_result':
    switch (part.result.status) {
    case 'success': return storedText({ value: part.result.content });
    case 'error': return `[${part.result.error.code}] ${storedText({ value: part.result.error.message }) ?? ''}`;
    case 'executing': return lazyStrings.workflow__running();
    default: {
      const exhaustive: never = part.result;
      throw new Error(String(exhaustive));
    }
    }
  case 'attachment': return part.attachment.originalName;
  default: {
    const exhaustive: never = part;
    throw new Error(String(exhaustive));
  }
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
  <article tw-class="rounded-xl border border-gray-200 dark:border-gray-700 p-3 space-y-3" data-testid="workflow-result-viewer">
    <div tw-class="flex flex-wrap items-center gap-2">
      <h3 tw-class="text-sm font-medium break-all flex-1">{{ source.label }}</h3>
      <button v-if="!view" type="button" :disabled="loading" @click="load" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.workflow__view_result() }}</button>
      <button v-else type="button" @click="close" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs">{{ lazyStrings.workflow__close_result() }}</button>
    </div>
    <p v-if="error" role="alert" tw-class="text-sm text-red-600 dark:text-red-400 break-words">{{ error }}</p>
    <img v-if="view?.type === 'image'" :src="url" :alt="source.label" tw-class="max-w-full max-h-96 object-contain rounded-lg" />
    <audio v-else-if="view?.type === 'audio'" :src="url" controls preload="none" tw-class="w-full" :aria-label="source.label" />
    <pre v-else-if="view?.type === 'text'" tw-class="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">{{ view.text }}</pre>
    <div v-else-if="view?.type === 'conversation'" tw-class="space-y-3">
      <div tw-class="max-h-96 overflow-auto space-y-3">
        <section v-for="message in view.messages" :key="idToRaw({ id: message.id })" tw-class="rounded-lg bg-gray-50 dark:bg-gray-900 p-3">
          <h4 tw-class="text-xs font-semibold">{{ message.role }}</h4>
          <div v-for="(part, index) in message.parts" :key="index">
            <h5 v-if="part.type === 'reasoning'" tw-class="text-xs text-gray-500 dark:text-gray-400">{{ lazyStrings.workflow__reasoning_part() }}</h5>
            <pre tw-class="whitespace-pre-wrap break-words text-sm font-sans">{{ partText({ part }) }}</pre>
          </div>
        </section>
      </div>
      <button type="button" :disabled="copying" @click="continueInChat" tw-class="rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-xs disabled:opacity-40">{{ lazyStrings.workflow__continue_in_chat() }}</button>
    </div>
  </article>
</template>
