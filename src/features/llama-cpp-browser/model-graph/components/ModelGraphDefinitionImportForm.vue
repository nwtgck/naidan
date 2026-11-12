<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from 'vue';
import { CheckIcon, FilePlus2Icon, PlusIcon, XIcon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import { lazyStrings } from '@/strings';
import type { ModelGraphRegistration } from '@/01-models/model-graph-registry';
import { modelGraphSourceDigest } from '@/01-models/model-graph-registry';
import { parseModelGraphDefinitions } from '@/features/llama-cpp-browser/model-graph/definition';

const props = defineProps<{ input: string; disabled: boolean; registrations: readonly ModelGraphRegistration[] }>();
const emit = defineEmits<{ 'update:input': [input: string]; register: [selection: { input: string; source: string | undefined }]; error: [message: string]; readingChanged: [reading: boolean] }>();
const parsed = ref<{ source: string; digest: string; name: string; architecture: string }[]>([]);
const error = ref('');
const pending = ref(false);
const reading = ref(false);
const unavailable = computed(() => props.disabled || reading.value);
const preview = computed(() => parsed.value.map(entry => ({
  ...entry,
  status: props.registrations.some(registration => registration.sourceSha256 === entry.digest) ? 'registered' as const
    : props.registrations.some(registration => registration.rule.mode !== 'disabled' && registration.rule.architecture === entry.architecture) ? 'architecture-in-use' as const : 'ready' as const,
})));
const unregistered = computed(() => preview.value.filter(entry => entry.status !== 'registered'));
const repeatedArchitecture = computed(() => new Set(unregistered.value.map(entry => entry.architecture)).size !== unregistered.value.length);
const canRegister = computed(() => !unavailable.value && !pending.value && !error.value);
const canRegisterAll = computed(() => canRegister.value && unregistered.value.length > 0 && !repeatedArchitecture.value && unregistered.value.every(entry => entry.status === 'ready'));
let timer: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
watch(() => props.input, input => {
  clearTimeout(timer);
  pending.value = true;
  parsed.value = [];
  error.value = '';
  timer = setTimeout(() => {
    try {
      if (input.trim()) {
        parsed.value = parseModelGraphDefinitions({ input }).map(({ source, definition }) => ({ source, digest: modelGraphSourceDigest({ source }), name: definition.name, architecture: definition.applicability.architecture }));
      }
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
    pending.value = false;
  }, 200);
}, { immediate: true, flush: 'sync' });
onScopeDispose(() => {
  disposed = true;
  clearTimeout(timer);
});

function register({ source }: { source: string | undefined }): void {
  if (!canRegister.value || source === undefined && !canRegisterAll.value || source !== undefined && !preview.value.some(entry => entry.source === source && entry.status === 'ready')) {
    return;
  }
  emit('register', { input: props.input, source });
}

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
  <div tw-class="space-y-3" :aria-busy="reading || pending">
    <label tw-class="block space-y-2">
      <span tw-class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ lazyStrings.modelGraphDefinitionRegistry__paste_multiple_json_objects() }}</span>
      <textarea :value="input" @input="updateInput({ event: $event })" :disabled="unavailable" rows="5" spellcheck="false" autocapitalize="off" :maxlength="4 * 1024 * 1024" data-testid="model-graph-input" tw-class="block w-full resize-y rounded-xl border border-gray-200/80 bg-gray-50/60 px-3 py-2.5 font-mono text-sm leading-relaxed text-gray-700 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-60 dark:border-gray-700/70 dark:bg-gray-900/40 dark:text-gray-300" />
    </label>
    <div tw-class="flex flex-wrap items-center justify-between gap-3">
      <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__objects_can_span_multiple_lines() }}</p>
      <div tw-class="flex flex-wrap items-center gap-2">
        <label :tw-class="['inline-flex min-h-9 items-center gap-2 rounded-lg border border-gray-200/80 bg-white/70 px-3 py-2 text-sm font-medium text-gray-600 focus-within:ring-2 focus-within:ring-blue-500/40 dark:border-gray-700/70 dark:bg-gray-800/40 dark:text-gray-300', unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800']">
          <FilePlus2Icon aria-hidden="true" tw-class="h-4 w-4 text-blue-500 dark:text-blue-400" />{{ lazyStrings.modelGraphDefinitionRegistry__add_files() }}
          <input data-testid="model-graph-files" type="file" multiple accept=".json,application/json,text/plain" :disabled="unavailable" @change="addFiles({ event: $event })" tw-class="sr-only" />
        </label>
        <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="unavailable || !input" @click="emit('update:input', '')" tw-class="text-sm!" data-testid="model-graph-clear-input"><XIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__clear_input() }}</ActionButton>
      </div>
    </div>
    <p v-if="error" role="alert" tw-class="break-words text-sm leading-relaxed text-red-600 dark:text-red-400">{{ error }}</p>
    <div v-if="preview.length" tw-class="overflow-hidden rounded-xl border border-dashed border-gray-300 bg-gray-50/50 dark:border-gray-700 dark:bg-gray-900/20" data-testid="model-graph-preview">
      <div tw-class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <h4 tw-class="text-sm font-medium text-gray-600 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__preview() }} · {{ preview.length }}</h4>
        <ActionButton appearance="primary" :icon-tone="undefined" :disabled="!canRegisterAll" @click="register({ source: undefined })" data-testid="model-graph-register" tw-class="text-sm!"><PlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__register_definitions() }}</ActionButton>
      </div>
      <ul tw-class="max-h-80 divide-y divide-gray-200/70 overflow-y-auto border-t border-gray-200/70 dark:divide-gray-800 dark:border-gray-800">
        <li v-for="(entry, index) in preview" :key="entry.digest + ':' + index" data-testid="model-graph-preview-entry" tw-class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <div tw-class="min-w-0 flex-1 space-y-1">
            <div tw-class="flex flex-wrap items-baseline gap-x-3 gap-y-1"><span tw-class="break-words text-sm font-medium text-gray-700 dark:text-gray-300">{{ entry.name }}</span><code tw-class="break-all text-xs text-gray-500 dark:text-gray-400">{{ entry.architecture }}</code></div>
            <span v-if="entry.status === 'registered'" role="status" tw-class="inline-flex items-center gap-1.5 text-sm text-blue-600 dark:text-blue-400"><CheckIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.modelGraphDefinitionRegistry__registered() }}</span>
            <span v-else tw-class="text-sm text-amber-700 dark:text-amber-400">{{ lazyStrings.modelGraphDefinitionRegistry__unregistered() }}</span>
            <p v-if="entry.status === 'architecture-in-use'" tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__architecture_is_already_in_use() }}</p>
          </div>
          <ActionButton appearance="primary" :icon-tone="undefined" :disabled="!canRegister || entry.status !== 'ready'" @click="register({ source: entry.source })" data-testid="model-graph-register-entry" tw-class="shrink-0 text-sm!"><PlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__register_and_use() }}</ActionButton>
        </li>
      </ul>
      <p v-if="repeatedArchitecture" tw-class="border-t border-gray-200/70 px-4 py-3 text-sm leading-relaxed text-amber-700 dark:border-gray-800 dark:text-amber-400">{{ lazyStrings.modelGraphDefinitionRegistry__choose_one_definition_per_architecture() }}</p>
      <p tw-class="border-t border-gray-200/70 px-4 py-3 text-sm leading-relaxed text-gray-500 dark:border-gray-800 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__registration_enables_native_replacement() }}</p>
    </div>
    <ActionButton v-else appearance="primary" :icon-tone="undefined" :disabled="true" data-testid="model-graph-register" tw-class="text-sm!"><PlusIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__register_definitions() }}</ActionButton>
  </div>
</template>
