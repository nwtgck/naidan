<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { lazyStrings } from '@/strings';
import { useBrowserModelLocalInputSelection } from '@/composables/useLocalModelStart';
import { localModelChatGroupName } from '@/features/llama-cpp-browser/chat-group-name';
import LlamaCppBrowserRepositoryLayout from '@/features/llama-cpp-browser/components/LlamaCppBrowserRepositoryLayout.vue';
import LlamaCppBrowserLocalRepositorySaves from '@/features/llama-cpp-browser/components/LlamaCppBrowserLocalRepositorySaves.vue';

const { selection, choose, cancel } = useBrowserModelLocalInputSelection();
const selectedModelId = ref<string>();
const dialog = ref<HTMLElement>();
const busy = computed(() => selection.value?.status === 'starting');
watch(() => selection.value?.models.map(model => model.modelId).join('\n'), () => {
  selectedModelId.value = undefined;
});
watch(dialog, element => {
  element?.focus();
}, { flush: 'post' });

function trapFocus({ event }: { event: KeyboardEvent }): void {
  const elements = dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
  const first = elements?.[0];
  const last = elements?.[elements.length - 1];
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

async function start(): Promise<void> {
  if (selectedModelId.value !== undefined) {
    await choose({ modelId: selectedModelId.value });
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
  <Teleport to="body">
    <div v-if="selection" data-testid="local-model-selection" tw-class="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4" @keydown.esc="cancel">
      <section ref="dialog" role="dialog" aria-modal="true" aria-labelledby="local-model-selection-title" tabindex="-1" @keydown.tab="trapFocus({ event: $event })" tw-class="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-700 dark:bg-gray-900">
        <h2 id="local-model-selection-title" tw-class="text-lg font-bold text-gray-900 dark:text-white">{{ selection.kind === 'layout' ? lazyStrings.LlamaCppBrowserRepositoryLayout__confirm_folder_layout() : lazyStrings.LocalModelSelectionDialog__choose_a_model_configuration() }}</h2>
        <LlamaCppBrowserRepositoryLayout v-if="selection.kind === 'layout'" :root-name="selection.rootName" :choices="selection.choices" heading="hidden" tw-class="mt-4" @choose="selection.kind === 'layout' && selection.chooseLayout({ layout: $event })" @cancel="cancel" />
        <template v-else>
          <p tw-class="mt-2 text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.LocalModelSelectionDialog__these_files_contain_multiple_model_configurations() }}</p>
          <div tw-class="mt-4 max-h-80 space-y-2 overflow-y-auto">
            <label v-for="model in selection.models" :key="model.modelId" tw-class="flex cursor-pointer items-start gap-3 rounded-xl border border-gray-200 p-3 dark:border-gray-700">
              <input v-model="selectedModelId" type="radio" name="local-model-configuration" :value="model.modelId" :disabled="busy" :data-testid="`local-model-choice-${model.modelId}`" tw-class="mt-1 shrink-0" />
              <span tw-class="min-w-0 break-all text-sm text-gray-900 dark:text-gray-100">{{ localModelChatGroupName({ model }) }}<span tw-class="mt-1 block text-xs text-gray-500 dark:text-gray-400">{{ model.modelId }}</span></span>
            </label>
          </div>
          <p v-if="selection.error" role="alert" data-testid="local-model-selection-error" tw-class="mt-3 text-sm text-red-600 dark:text-red-400">{{ lazyStrings.LocalModelSelectionDialog__could_not_start_the_model_try_again() }}</p>
          <LlamaCppBrowserLocalRepositorySaves offered-visibility="hidden" tw-class="mt-4" />
          <div tw-class="mt-6 flex justify-end gap-3">
            <button type="button" @click="cancel" data-testid="local-model-selection-cancel" tw-class="rounded-lg px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">{{ lazyStrings.LocalModelSelectionDialog__cancel() }}</button>
            <button type="button" @click="start" :disabled="busy || selectedModelId === undefined" data-testid="local-model-selection-start" tw-class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">{{ lazyStrings.LocalModelSelectionDialog__start() }}</button>
          </div>
        </template>
      </section>
    </div>
  </Teleport>
</template>
