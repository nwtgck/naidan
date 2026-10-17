<script setup lang="ts">
import type { SystemPrompt } from '@/01-models/types';
import { computed, ref, watch } from 'vue';
import { MessageSquareQuoteIcon } from 'lucide-vue-next';
import { systemPromptUiModeFromValue, type SystemPromptUiMode } from './system-prompt-settings-editor';

const props = defineProps<{
  modelValue: SystemPrompt | undefined,
  title: string | undefined,
  parentModeLabel: string | undefined,
  noPromptModeLabel: string | undefined,
  replaceModeLabel: string | undefined,
  appendModeLabel: string | undefined,
  parentPromptText: string,
  parentPromptSetCaption: string | undefined,
  parentPromptNotSetCaption: string | undefined,
  noPromptCaption: string | undefined,
  replaceCaption: string | undefined,
  appendCaption: string | undefined,
  typeToReplacePlaceholder: string | undefined,
  replacePlaceholder: string | undefined,
  appendPlaceholder: string | undefined,
  resetKey: string,
  testIdPrefix: string,
  rows: number,
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: SystemPrompt | undefined): void,
  (event: 'save'): void,
}>();

const editorBuffer = ref<string | undefined>(undefined);
const mode = computed<SystemPromptUiMode>(() => systemPromptUiModeFromValue({ systemPrompt: props.modelValue }));

function initializeEditingSession({
  systemPrompt,
}: {
  systemPrompt: SystemPrompt | undefined,
}): void {
  if (systemPrompt === undefined) {
    editorBuffer.value = undefined;
    return;
  }

  switch (systemPrompt.behavior) {
  case 'override':
    editorBuffer.value = systemPrompt.content ?? undefined;
    return;
  case 'append':
    editorBuffer.value = systemPrompt.content;
    return;
  default: {
    const _ex: never = systemPrompt;
    throw new Error(`Unhandled system prompt behavior: ${String(_ex)}`);
  }
  }
}

watch(
  () => props.resetKey,
  () => initializeEditingSession({ systemPrompt: props.modelValue }),
  { immediate: true },
);

// Keep one editor buffer for the lifetime of the open settings panel. Replace
// and Append are persistence modes for the same user-written text, so switching
// between them must never swap or reconstruct the textarea value from the DTO
// echoed back by immediate persistence. The visible mode is still derived from
// the persisted value, which keeps external actions such as Restore Defaults in
// sync. Parent and No Prompt display their own effective state without clearing
// this buffer, preventing exploratory or accidental mode changes from destroying
// in-progress input. `undefined` means no editable buffer has been materialized
// yet: direct Append can start empty, while Replace can still begin from the
// effective parent prompt.
function editorTextForCurrentMode(): string {
  switch (mode.value) {
  case 'parent':
    return props.parentPromptText;
  case 'no_prompt':
    return '';
  case 'replace':
  case 'append':
    return editorBuffer.value ?? '';
  default: {
    const _ex: never = mode.value;
    throw new Error(`Unhandled system prompt UI mode: ${_ex}`);
  }
  }
}

function updateEditorContent({
  content,
}: {
  content: string,
}): void {
  editorBuffer.value = content;

  switch (mode.value) {
  case 'parent':
  case 'no_prompt':
  case 'replace':
    emit('update:modelValue', { behavior: 'override', content });
    return;
  case 'append':
    emit('update:modelValue', { behavior: 'append', content });
    return;
  default: {
    const _ex: never = mode.value;
    throw new Error(`Unhandled system prompt UI mode: ${_ex}`);
  }
  }
}

const editorText = computed<string>({
  get: editorTextForCurrentMode,
  set: content => updateEditorContent({ content }),
});

const editorPlaceholder = computed(() => {
  switch (mode.value) {
  case 'parent':
  case 'no_prompt':
    return props.typeToReplacePlaceholder;
  case 'replace':
    return props.replacePlaceholder;
  case 'append':
    return props.appendPlaceholder;
  default: {
    const _ex: never = mode.value;
    throw new Error(`Unhandled system prompt UI mode: ${_ex}`);
  }
  }
});

function updateMode({
  nextMode,
}: {
  nextMode: SystemPromptUiMode,
}): void {
  switch (nextMode) {
  case 'parent':
    emit('update:modelValue', undefined);
    break;
  case 'no_prompt':
    emit('update:modelValue', { behavior: 'override', content: null });
    break;
  case 'replace': {
    const content = editorBuffer.value ?? props.parentPromptText;
    editorBuffer.value = content;
    emit('update:modelValue', { behavior: 'override', content });
    break;
  }
  case 'append': {
    const content = editorBuffer.value ?? '';
    editorBuffer.value = content;
    emit('update:modelValue', { behavior: 'append', content });
    break;
  }
  default: {
    const _ex: never = nextMode;
    throw new Error(`Unhandled system prompt UI mode: ${_ex}`);
  }
  }

  emit('save');
}

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <div tw-class="space-y-3">
    <div tw-class="flex flex-wrap items-center justify-between gap-3">
      <label tw-class="text-sm font-normal text-gray-700 dark:text-gray-200 flex items-center gap-2">
        <MessageSquareQuoteIcon tw-class="w-4 h-4" />
        {{ title }}
      </label>

      <div tw-class="inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg bg-slate-100/80 p-0.5 dark:bg-[#131e2e]">
        <button
          @click="updateMode({ nextMode: 'parent' })"
          :aria-pressed="mode === 'parent'"
          :tw-class="['min-h-8 px-3 text-xs font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30', mode === 'parent' ? 'bg-blue-400/10 text-blue-600 inset-ring-1 inset-ring-blue-400/25 dark:text-blue-400 hover:bg-blue-400/15' : 'text-slate-600 dark:text-slate-300 hover:bg-blue-100/60 hover:text-blue-700 dark:hover:bg-[#1c2b42] dark:hover:text-blue-300']"
          :data-testid="`${testIdPrefix}-parent-button`"
        >
          {{ parentModeLabel }}
        </button>
        <button
          @click="updateMode({ nextMode: 'no_prompt' })"
          :aria-pressed="mode === 'no_prompt'"
          :tw-class="['min-h-8 px-3 text-xs font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30', mode === 'no_prompt' ? 'bg-blue-400/10 text-blue-600 inset-ring-1 inset-ring-blue-400/25 dark:text-blue-400 hover:bg-blue-400/15' : 'text-slate-600 dark:text-slate-300 hover:bg-blue-100/60 hover:text-blue-700 dark:hover:bg-[#1c2b42] dark:hover:text-blue-300']"
          :data-testid="`${testIdPrefix}-no-prompt-button`"
        >
          {{ noPromptModeLabel }}
        </button>
        <button
          @click="updateMode({ nextMode: 'replace' })"
          :aria-pressed="mode === 'replace'"
          :tw-class="['min-h-8 px-3 text-xs font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30', mode === 'replace' ? 'bg-blue-400/10 text-blue-600 inset-ring-1 inset-ring-blue-400/25 dark:text-blue-400 hover:bg-blue-400/15' : 'text-slate-600 dark:text-slate-300 hover:bg-blue-100/60 hover:text-blue-700 dark:hover:bg-[#1c2b42] dark:hover:text-blue-300']"
          :data-testid="`${testIdPrefix}-replace-button`"
        >
          {{ replaceModeLabel }}
        </button>
        <button
          @click="updateMode({ nextMode: 'append' })"
          :aria-pressed="mode === 'append'"
          :tw-class="['min-h-8 px-3 text-xs font-medium rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30', mode === 'append' ? 'bg-blue-400/10 text-blue-600 inset-ring-1 inset-ring-blue-400/25 dark:text-blue-400 hover:bg-blue-400/15' : 'text-slate-600 dark:text-slate-300 hover:bg-blue-100/60 hover:text-blue-700 dark:hover:bg-[#1c2b42] dark:hover:text-blue-300']"
          :data-testid="`${testIdPrefix}-append-button`"
        >
          {{ appendModeLabel }}
        </button>
      </div>
    </div>

    <div class="prompt-caption-stack" tw-class="text-xs leading-5 text-gray-400 dark:text-gray-500">
      <p v-for="captionMode in ['parent', 'no_prompt', 'replace', 'append'] as const" :key="captionMode" :aria-hidden="captionMode !== mode" :class="{ 'prompt-caption-inactive': captionMode !== mode }" :data-testid="captionMode === mode ? `${testIdPrefix}-caption` : undefined">{{ captionMode === 'parent' ? (parentPromptText ? parentPromptSetCaption : parentPromptNotSetCaption) : captionMode === 'no_prompt' ? noPromptCaption : captionMode === 'replace' ? replaceCaption : appendCaption }}</p>
    </div>
    <!-- Keep the same textarea mounted in every mode so changing state does not move the settings below it. -->
    <textarea
      v-model="editorText"
      @blur="emit('save')"
      :rows="rows"
      tw-class="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700/60 rounded-xl px-4 py-3 text-sm font-normal text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-colors dark:text-white resize-y"
      :placeholder="editorPlaceholder"
      :data-testid="`${testIdPrefix}-textarea`"
    ></textarea>
  </div>
</template>

<style scoped>
.prompt-caption-stack {
  display: grid;
}
.prompt-caption-stack > p {
  grid-area: 1 / 1;
}
.prompt-caption-inactive {
  visibility: hidden;
}
</style>
