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

const editorCaption = computed(() => {
  switch (mode.value) {
  case 'parent':
    return props.parentPromptText ? props.parentPromptSetCaption : props.parentPromptNotSetCaption;
  case 'no_prompt':
    return props.noPromptCaption;
  case 'replace':
    return props.replaceCaption;
  case 'append':
    return props.appendCaption;
  default: {
    const _ex: never = mode.value;
    throw new Error(`Unhandled system prompt UI mode: ${_ex}`);
  }
  }
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
  <div tw-class="space-y-4">
    <div tw-class="flex items-center justify-between gap-3">
      <label tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1 flex items-center gap-2">
        <MessageSquareQuoteIcon tw-class="w-3 h-3" />
        {{ title }}
      </label>

      <div tw-class="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 p-1 rounded-lg">
        <button
          @click="updateMode({ nextMode: 'parent' })"
          :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', mode === 'parent' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
          :data-testid="`${testIdPrefix}-parent-button`"
        >
          {{ parentModeLabel }}
        </button>
        <button
          @click="updateMode({ nextMode: 'no_prompt' })"
          :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', mode === 'no_prompt' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
          :data-testid="`${testIdPrefix}-no-prompt-button`"
        >
          {{ noPromptModeLabel }}
        </button>
        <button
          @click="updateMode({ nextMode: 'replace' })"
          :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', mode === 'replace' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
          :data-testid="`${testIdPrefix}-replace-button`"
        >
          {{ replaceModeLabel }}
        </button>
        <button
          @click="updateMode({ nextMode: 'append' })"
          :tw-class="['px-2 py-0.5 text-[9px] font-bold rounded transition-all', mode === 'append' ? 'bg-white dark:bg-gray-700 text-blue-600 shadow-sm' : 'text-gray-400 hover:text-gray-600']"
          :data-testid="`${testIdPrefix}-append-button`"
        >
          {{ appendModeLabel }}
        </button>
      </div>
    </div>

    <p tw-class="text-[10px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-widest ml-1" :data-testid="`${testIdPrefix}-caption`">
      {{ editorCaption }}
    </p>
    <!-- Keep the same textarea mounted in every mode so changing state does not move the settings below it. -->
    <textarea
      v-model="editorText"
      @blur="emit('save')"
      :rows="rows"
      tw-class="w-full bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-xl px-4 py-3 text-sm font-medium text-gray-800 focus:ring-4 focus:ring-blue-500/10 outline-none transition-all dark:text-white shadow-sm resize-none"
      :placeholder="editorPlaceholder"
      :data-testid="`${testIdPrefix}-textarea`"
    ></textarea>
  </div>
</template>
