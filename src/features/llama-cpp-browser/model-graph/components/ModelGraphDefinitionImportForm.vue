<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { FilePlus2Icon, PlusIcon, XIcon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import { lazyStrings } from '@/strings';
import { parseModelGraphDefinitions } from '@/features/llama-cpp-browser/model-graph/definition';

const props = defineProps<{ input: string; disabled: boolean }>();
const emit = defineEmits<{ 'update:input': [input: string]; register: []; error: [message: string]; readingChanged: [reading: boolean] }>();
const preview = ref<{ name: string; architecture: string }[]>([]);
const error = ref('');
const pending = ref(false);
const reading = ref(false);
const unavailable = computed(() => props.disabled || reading.value);
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
watch(() => props.input, () => {
  clearTimeout(timer);
  pending.value = true;
  preview.value = [];
  error.value = '';
  timer = setTimeout(() => {
    try {
      if (props.input.trim()) {
        preview.value = parseModelGraphDefinitions({ input: props.input }).map(({ definition }) => ({ name: definition.name, architecture: definition.applicability.architecture }));
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
    pending.value = false;
  }, 200);
}, { immediate: true });
onScopeDispose(() => {
  disposed = true;
  clearTimeout(timer);
});
const canRegister = computed(() => !unavailable.value && !pending.value && !error.value && preview.value.length > 0);

async function addFiles({ event }: { event: Event }): Promise<void> {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.files || unavailable.value) {
    return;
  }
  const files = Array.from(target.files);
  target.value = '';
  const initial = props.input;
  reading.value = true;
  emit('readingChanged', true);
  try {
    if (files.length > 32 || files.some(file => file.size > 1024 * 1024) || files.reduce((sum, file) => sum + file.size, new TextEncoder().encode(initial).byteLength) > 4 * 1024 * 1024) {
      throw new Error('Model graph input exceeds the size limit');
    }
    const sources = await Promise.all(files.map(file => file.text()));
    if (disposed) {
      return;
    }
    if (props.input !== initial) {
      throw new Error('Input changed while files were being read. Select the files again.');
    }
    emit('update:input', [initial, ...sources].filter(source => source.trim()).join('\n\n'));
  } catch (cause) {
    if (!disposed) {
      emit('error', cause instanceof Error ? cause.message : String(cause));
    }
  } finally {
    reading.value = false;
    if (!disposed) {
      emit('readingChanged', false);
    }
  }
}

function updateInput({ event }: { event: Event }): void {
  if (!unavailable.value && event.target instanceof HTMLTextAreaElement) {
    emit('update:input', event.target.value);
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-3" :aria-busy="reading">
    <label tw-class="block space-y-2">
      <span tw-class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ lazyStrings.modelGraphDefinitionRegistry__paste_multiple_json_objects() }}</span>
      <textarea :value="input" @input="updateInput({ event: $event })" :disabled="unavailable" rows="7" spellcheck="false" autocapitalize="off" :maxlength="4 * 1024 * 1024" data-testid="model-graph-input" tw-class="block w-full resize-y rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-xs text-gray-800 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100" />
    </label>
    <p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__objects_can_span_multiple_lines() }}</p>
    <p v-if="error" role="alert" tw-class="break-words rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">{{ error }}</p>
    <div v-if="preview.length" tw-class="rounded-lg border border-gray-200 bg-gray-50/60 px-3 py-2 dark:border-gray-700 dark:bg-gray-800/30" data-testid="model-graph-preview">
      <h4 tw-class="mb-2 text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.modelGraphDefinitionRegistry__preview() }} · {{ preview.length }}</h4>
      <ul tw-class="max-h-40 space-y-1 overflow-y-auto text-xs text-gray-700 dark:text-gray-200"><li v-for="(entry, index) in preview" :key="index" tw-class="flex flex-wrap items-baseline justify-between gap-2"><span tw-class="break-words">{{ entry.name }}</span><code tw-class="text-gray-500 dark:text-gray-400">{{ entry.architecture }}</code></li></ul>
    </div>
    <div tw-class="flex flex-wrap items-center gap-2">
      <ActionButton appearance="primary" :icon-tone="undefined" :disabled="!canRegister" @click="emit('register')" data-testid="model-graph-register"><PlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__register_definitions() }}</ActionButton>
      <label :tw-class="['inline-flex min-h-9 items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-xs font-medium text-gray-600 focus-within:ring-2 focus-within:ring-blue-500/40 dark:border-gray-700 dark:text-gray-300', unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800']">
        <FilePlus2Icon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__add_files() }}
        <input data-testid="model-graph-files" type="file" multiple accept=".json,application/json,text/plain" :disabled="unavailable" @change="addFiles({ event: $event })" tw-class="sr-only" />
      </label>
      <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="unavailable || !input" @click="emit('update:input', '')"><XIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__clear_input() }}</ActionButton>
    </div>
  </div>
</template>
