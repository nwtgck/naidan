<script setup lang="ts">
import { CopyIcon, ReplaceIcon, Trash2Icon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import { lazyStrings } from '@/strings';
import type { ModelGraphRegistration, ModelGraphUseRule } from '@/01-models/model-graph-registry';
const props = defineProps<{ registration: ModelGraphRegistration; disabled: boolean; hasInput: boolean }>();
const emit = defineEmits<{ rule: [mode: ModelGraphUseRule['mode']]; copy: []; replace: []; remove: [] }>();

function changeRule({ event }: { event: Event }): void {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }
  const mode = target.value;
  target.value = props.registration.rule.mode; // Reflect only a committed, approved change.
  switch (mode) {
  case 'disabled': case 'whenArchitectureUnknown': case 'replaceNative': emit('rule', mode);
    break;
  default: throw new Error('Invalid model graph usage rule');
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <article tw-class="min-w-0 space-y-3 rounded-xl border border-gray-200/80 bg-white/60 p-3 dark:border-gray-700/70 dark:bg-gray-800/25" data-testid="model-graph-registration">
    <div tw-class="flex flex-wrap items-start justify-between gap-2"><h4 tw-class="min-w-0 break-words text-sm font-medium text-gray-800 dark:text-gray-100">{{ registration.label }}</h4><code v-if="registration.rule.mode !== 'disabled'" tw-class="rounded bg-blue-50 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">{{ registration.rule.architecture }}</code></div>
    <label tw-class="block space-y-1.5"><span tw-class="text-xs text-gray-600 dark:text-gray-300">{{ lazyStrings.modelGraphDefinitionRegistry__usage_rule() }}</span>
      <select :value="registration.rule.mode" @change="changeRule({ event: $event })" :disabled="disabled" data-testid="model-graph-usage-rule" tw-class="block w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs text-gray-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
        <option value="disabled">{{ lazyStrings.modelGraphDefinitionRegistry__register_only() }}</option><option value="whenArchitectureUnknown">{{ lazyStrings.modelGraphDefinitionRegistry__use_when_architecture_unknown() }}</option><option value="replaceNative">{{ lazyStrings.modelGraphDefinitionRegistry__replace_native_implementation() }}</option>
      </select>
    </label>
    <details tw-class="text-xs text-gray-500 dark:text-gray-400"><summary tw-class="cursor-pointer">{{ lazyStrings.modelGraphDefinitionRegistry__source() }} · {{ registration.sourceSha256.slice(0, 12) }}</summary><pre tw-class="mt-2 max-h-52 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-gray-50 p-2 font-mono text-xs dark:bg-gray-900">{{ registration.source }}</pre></details>
    <div tw-class="flex flex-wrap gap-2"><ActionButton appearance="secondary" :icon-tone="undefined" :disabled="disabled" @click="emit('copy')"><CopyIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.modelGraphDefinitionRegistry__copy_definitions() }}</ActionButton><ActionButton appearance="secondary" :icon-tone="undefined" :disabled="disabled || !hasInput" @click="emit('replace')"><ReplaceIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.modelGraphDefinitionRegistry__replace_from_input() }}</ActionButton><ActionButton appearance="danger" :icon-tone="undefined" :disabled="disabled" @click="emit('remove')"><Trash2Icon aria-hidden="true" tw-class="h-3.5 w-3.5" />{{ lazyStrings.modelGraphDefinitionRegistry__delete_definition() }}</ActionButton></div>
  </article>
</template>
