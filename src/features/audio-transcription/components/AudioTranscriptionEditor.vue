<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const props = defineProps<{ provisionalText: string, confirmedRevision: number, surface: 'workspace' | 'floating', clearDisabled: boolean }>();
const emit = defineEmits<{ clear: [] }>();
const text = defineModel<string>({ required: true });
const scroll = ref<HTMLElement>();
const editor = ref<HTMLTextAreaElement>();
const editing = ref(false);

watch([() => props.provisionalText, () => props.confirmedRevision], async () => {
  const viewport = scroll.value;
  const input = editor.value;
  if (viewport === undefined || input === undefined) {
    return;
  }
  const owner = input.ownerDocument;
  const isEditing = owner.activeElement === input;
  const selection = isEditing ? { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection } : undefined;
  const follow = !isEditing && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32;
  await nextTick();
  if (selection !== undefined && owner.activeElement === input) {
    input.setSelectionRange(selection.start, selection.end, selection.direction);
  }
  if (follow && owner.activeElement !== input) {
    viewport.scrollTop = viewport.scrollHeight;
  }
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div :tw-class="['flex min-h-0 flex-1 flex-col', surface === 'floating' && 'rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900']">
    <div tw-class="flex min-h-0 flex-1">
      <div ref="scroll" :tw-class="['min-h-0 min-w-0 flex-1 overflow-y-auto', surface === 'floating' ? 'py-2 pl-3 pr-1 text-sm leading-6' : 'py-4 pl-5 pr-2 text-base leading-7 sm:pl-7 sm:leading-8']">
        <!-- The hidden mirror sizes the native editor and keeps the provisional text in the same scroll area. -->
        <div v-show="text || !provisionalText || editing" tw-class="grid w-full">
          <div aria-hidden="true" tw-class="invisible col-start-1 row-start-1 min-w-0 whitespace-pre-wrap break-words">{{ text }}<br /></div>
          <textarea ref="editor" v-model="text" :data-testid="surface === 'floating' ? 'audio-transcription-floating-editor' : 'audio-transcription-editor'" :aria-label="lazyStrings.AudioTranscriptionWorkspace__edit_transcribed_text()" :placeholder="lazyStrings.AudioTranscriptionWorkspace__transcription_result()" spellcheck="false" rows="1" @focus="editing = true" @blur="editing = false" tw-class="col-start-1 row-start-1 w-full resize-none overflow-hidden bg-transparent p-0 text-inherit outline-none placeholder:text-gray-400 dark:placeholder:text-gray-500" />
        </div>
        <p v-if="provisionalText" :aria-label="lazyStrings.AudioTranscriptionWorkspace__partial_transcription()" :data-testid="surface === 'floating' ? 'audio-transcription-floating-provisional' : 'audio-transcription-provisional'" tw-class="whitespace-pre-wrap break-words text-gray-500 dark:text-gray-400">{{ provisionalText }}</p>
      </div>
      <button type="button" :data-testid="surface === 'floating' ? 'audio-transcription-floating-clear' : 'audio-transcription-clear'" :disabled="clearDisabled" :aria-label="lazyStrings.AudioTranscriptionWorkspace__clear_text()" :title="lazyStrings.AudioTranscriptionWorkspace__clear_text()" @click="emit('clear')" :tw-class="['grid h-8 w-8 shrink-0 place-items-center self-start rounded-md text-gray-600 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-800', surface === 'floating' ? 'mr-1 mt-1' : 'mr-2 mt-2 sm:mr-3']">
        <XIcon aria-hidden="true" tw-class="h-4 w-4" />
      </button>
    </div>
    <!-- Loading and clipboard updates share this fixed-height row to keep text stationary. -->
    <div data-testid="audio-transcription-editor-status" :tw-class="['flex h-9 shrink-0 items-center gap-3', surface === 'floating' ? 'px-2' : 'border-t border-gray-100 px-4 dark:border-gray-800 sm:px-5']">
      <div tw-class="min-w-0 flex-1 truncate text-xs tabular-nums text-gray-500 dark:text-gray-400"><slot name="status" /></div>
      <slot name="preparation" />
    </div>
  </div>
</template>
