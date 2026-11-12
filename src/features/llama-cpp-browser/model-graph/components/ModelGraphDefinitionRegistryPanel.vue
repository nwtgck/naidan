<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue';
import { AlertTriangleIcon, CopyIcon, NetworkIcon, RefreshCwIcon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import { idToRaw } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import type { ModelGraphRegistrySnapshot } from '@/00-storage/service/model-graph-registry';
import type { ModelGraphRegistration, ModelGraphUseRule } from '@/01-models/model-graph-registry';
import { useConfirm } from '@/composables/useConfirm';
import { ensureStrings, lazyStrings } from '@/strings';
import { downloadBlob } from '@/utils/stream-download';
import { sanitizeFilename } from '@/utils/string';
import { importModelGraphRegistrations, registerModelGraphDefinitions, setModelGraphUseRule } from '@/features/llama-cpp-browser/model-graph/registry';
import ModelGraphDefinitionImportForm from './ModelGraphDefinitionImportForm.vue';
import ModelGraphDefinitionRow from './ModelGraphDefinitionRow.vue';

const props = defineProps<{ input: string }>();
const emit = defineEmits<{ 'update:input': [input: string] }>();
const snapshot = shallowRef<ModelGraphRegistrySnapshot>();
const readingInput = ref(false);
const busy = ref(false), error = ref(''), message = ref('');
const { showConfirm } = useConfirm();
let disposed = false, loadVersion = 0;
const writable = computed(() => snapshot.value !== undefined && !busy.value && !readingInput.value);

async function reload(): Promise<void> {
  const version = ++loadVersion;
  busy.value = true;
  error.value = '';
  try {
    const next = await storageService.loadModelGraphRegistry();
    if (!disposed && loadVersion === version) {
      snapshot.value = next;
    }
  } catch (cause) {
    if (!disposed && loadVersion === version) {
      snapshot.value = undefined;
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && loadVersion === version) {
      busy.value = false;
    }
  }
}

async function transact({ build, confirmation, clearInput, expectedInput }: {
  build({ current, input }: { current: ModelGraphRegistrySnapshot; input: string }): ModelGraphRegistration[],
  confirmation: 'replace_native' | 'replace' | 'delete' | undefined,
  clearInput: boolean,
  expectedInput: string | undefined,
}): Promise<void> {
  const current = snapshot.value;
  if (!current || busy.value || readingInput.value) {
    return;
  }
  const input = props.input;
  const version = ++loadVersion;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    if (expectedInput !== undefined && expectedInput !== input) {
      throw new Error(await ensureStrings.modelGraphDefinitionRegistry__input_changed_review_again());
    }
    const registrations = build({ current, input });
    if (confirmation) {
      const dialog = await (async () => {
        switch (confirmation) {
        case 'replace_native': return { title: await ensureStrings.modelGraphDefinitionRegistry__confirm_native_replacement(), message: await ensureStrings.modelGraphDefinitionRegistry__native_replacement_changes_all_matching_requests(), confirmButtonVariant: 'default' as const };
        case 'replace': return { title: await ensureStrings.modelGraphDefinitionRegistry__experimental_model_graph_definitions(), message: await ensureStrings.modelGraphDefinitionRegistry__replacement_requires_new_approval(), confirmButtonVariant: 'default' as const };
        case 'delete': return { title: await ensureStrings.modelGraphDefinitionRegistry__experimental_model_graph_definitions(), message: await ensureStrings.modelGraphDefinitionRegistry__delete_definition_question(), confirmButtonVariant: 'danger' as const };
        default: {
          const exhaustive: never = confirmation;
          throw new Error(String(exhaustive));
        }
        }
      })();
      if (disposed || loadVersion !== version || !await showConfirm(dialog)) {
        return;
      }
    }
    if (disposed || loadVersion !== version) {
      return;
    }
    if (expectedInput !== undefined && props.input !== expectedInput) {
      throw new Error(await ensureStrings.modelGraphDefinitionRegistry__input_changed_review_again());
    }
    // CAS validates storage identity, provider generation, and revision while
    // holding the storage lock. Never rebase an approval onto unseen content.
    const next = await storageService.updateModelGraphRegistry({ access: current.access, registrations });
    if (!disposed && loadVersion === version) {
      snapshot.value = next;
      if (clearInput && props.input === input) {
        emit('update:input', '');
      }
    }
  } catch (cause) {
    if (!disposed) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  } finally {
    if (!disposed && loadVersion === version) {
      busy.value = false;
    }
  }
}

function register({ input, source }: { input: string; source: string | undefined }): void {
  void transact({ build: ({ current, input }) => [...current.registrations, ...registerModelGraphDefinitions({ input, source, existing: current.registrations })], confirmation: 'replace_native', clearInput: false, expectedInput: input });
}

function changeRule({ registration, mode }: { registration: ModelGraphRegistration; mode: ModelGraphUseRule['mode'] }): void {
  const confirmation = (() => {
    switch (mode) {
    case 'replace_native': return 'replace_native' as const;
    case 'disabled': case 'when_architecture_unknown': return undefined;
    default: {
      const exhaustive: never = mode;
      throw new Error(String(exhaustive));
    }
    }
  })();
  void transact({ build: ({ current }) => current.registrations.map(entry => entry.id === registration.id ? setModelGraphUseRule({ registration: entry, mode, registrations: current.registrations }) : entry), confirmation, clearInput: false, expectedInput: undefined });
}

function replace({ registration }: { registration: ModelGraphRegistration }): void {
  void transact({
    build: ({ current, input }) => {
      const imported = importModelGraphRegistrations({ input, existing: current.registrations.filter(entry => entry.id !== registration.id) });
      if (imported.length !== 1 || !imported[0]) {
        throw new Error('Replacement requires exactly one definition');
      }
      const replacement = { ...imported[0], id: registration.id };
      return current.registrations.map(entry => entry.id === registration.id ? replacement : entry);
    },
    confirmation: 'replace',
    clearInput: true,
    expectedInput: props.input,
  });
}

function remove({ registration }: { registration: ModelGraphRegistration }): void {
  void transact({ build: ({ current }) => current.registrations.filter(entry => entry.id !== registration.id), confirmation: 'delete', clearInput: false, expectedInput: undefined });
}

async function copy({ registrations }: { registrations: readonly ModelGraphRegistration[] }): Promise<void> {
  try {
    // Only portable definitions are copied. Usage rules and approvals stay local.
    await navigator.clipboard.writeText(registrations.map(entry => entry.source).join('\n\n'));
    const copied = await ensureStrings.modelGraphDefinitionRegistry__copied();
    if (!disposed) {
      message.value = copied;
    }
  } catch (cause) {
    if (!disposed) {
      error.value = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

function download({ registration }: { registration: ModelGraphRegistration }): void {
  if (disposed || !writable.value) {
    return;
  }
  error.value = '';
  try {
    // Download only the original definition, like Copy: local usage rules and
    // approvals are neither exported nor granted by importing this JSON.
    downloadBlob({ blob: new Blob([registration.source], { type: 'application/json' }), filename: sanitizeFilename({ base: registration.label, suffix: '.json', fallback: 'model-graph' }) });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}

onMounted(() => {
  void reload();
});
const unsubscribe = storageService.subscribeToChanges({
  listener: ({ event }) => {
    if (event.type === 'model_graph_registry' || event.type === 'migration') {
    // A remote update never changes a confirmation's captured authority. Keep
    // the old snapshot while busy so its later write fails with a conflict.
      if (!busy.value) {
        void reload();
      }
    }
  },
});
onScopeDispose(() => {
  disposed = true;
  loadVersion++;
  unsubscribe();
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section tw-class="space-y-5 border-t border-gray-200/70 pt-5 dark:border-gray-800" data-testid="model-graph-settings">
    <div tw-class="space-y-2">
      <h3 tw-class="flex items-center gap-2 text-base font-medium text-gray-700 dark:text-gray-300"><NetworkIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500 dark:text-blue-400" />{{ lazyStrings.modelGraphDefinitionRegistry__experimental_model_graph_definitions() }}</h3>
      <p tw-class="max-w-3xl text-sm leading-relaxed text-gray-600 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__use_registered_graphs_before_native_support() }}</p>
    </div>
    <div tw-class="flex items-start gap-2 rounded-xl border border-amber-200/70 bg-amber-50/50 px-3 py-2.5 text-sm leading-relaxed text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/15 dark:text-amber-300"><AlertTriangleIcon aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0" /><p>{{ lazyStrings.modelGraphDefinitionRegistry__format_may_change_without_migration() }}</p></div>
    <p v-if="snapshot?.access.persistence === 'session'" tw-class="text-sm leading-relaxed text-amber-700 dark:text-amber-400">{{ lazyStrings.modelGraphDefinitionRegistry__session_only_storage() }}</p>
    <p v-if="error" role="alert" tw-class="break-words text-sm leading-relaxed text-red-600 dark:text-red-400">{{ error }}</p>
    <p v-if="!snapshot && !busy" tw-class="text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__read_only_registry() }}</p>
    <ModelGraphDefinitionImportForm :input="input" :disabled="!writable" :registrations="snapshot?.registrations ?? []" @update:input="emit('update:input', $event)" @register="register" @error="error = $event" @reading-changed="readingInput = $event" />
    <div tw-class="space-y-3 border-t border-gray-200/70 pt-5 dark:border-gray-800">
      <div tw-class="flex flex-wrap items-center justify-between gap-3">
        <h4 tw-class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ lazyStrings.modelGraphDefinitionRegistry__registered_definitions() }}<span v-if="snapshot" tw-class="text-gray-500 dark:text-gray-400"> · {{ snapshot.registrations.length }}</span></h4>
        <div tw-class="flex flex-wrap gap-2">
          <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="busy || readingInput" @click="reload" tw-class="text-sm!"><RefreshCwIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__reload_registry() }}</ActionButton>
          <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="!writable || !snapshot?.registrations.length" @click="copy({ registrations: snapshot?.registrations ?? [] })" tw-class="text-sm!"><CopyIcon aria-hidden="true" tw-class="h-4 w-4" />{{ lazyStrings.modelGraphDefinitionRegistry__copy_definitions() }}</ActionButton>
        </div>
      </div>
      <p v-if="message" role="status" tw-class="text-sm text-blue-600 dark:text-blue-400">{{ message }}</p>
      <p v-if="snapshot && !snapshot.registrations.length" tw-class="py-5 text-center text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__no_definitions_registered() }}</p>
      <div v-else-if="snapshot?.registrations.length" tw-class="divide-y divide-gray-200/70 overflow-hidden rounded-xl border border-gray-200/80 bg-white/50 dark:divide-gray-800 dark:border-gray-700/70 dark:bg-gray-900/20">
        <ModelGraphDefinitionRow v-for="registration in snapshot.registrations" :key="idToRaw({ id: registration.id })" :registration="registration" :disabled="!writable" :has-input="!!input.trim()" @rule="changeRule({ registration, mode: $event })" @replace="replace({ registration })" @remove="remove({ registration })" @copy="copy({ registrations: [registration] })" @download="download({ registration })" />
      </div>
      <p tw-class="text-sm leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__changes_apply_to_the_next_request() }}</p>
    </div>
  </section>
</template>
