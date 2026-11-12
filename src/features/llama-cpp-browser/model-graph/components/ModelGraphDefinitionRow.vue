<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import { ChevronDownIcon, CopyIcon, DownloadIcon, ReplaceIcon, Trash2Icon } from 'lucide-vue-next';
import ActionButton from '@/components/ActionButton.vue';
import SettingsCollapse from '@/components/SettingsCollapse.vue';
import SettingsFormSelect from '@/components/SettingsFormSelect.vue';
import StandardCodeBlock from '@/components/block-markdown/StandardCodeBlock.vue';
import { lazyStrings } from '@/strings';
import type { ModelGraphRegistration, ModelGraphUseRule } from '@/01-models/model-graph-registry';
defineProps<{ registration: ModelGraphRegistration; disabled: boolean; hasInput: boolean }>();
const emit = defineEmits<{ rule: [mode: ModelGraphUseRule['mode']]; copy: []; download: []; replace: []; remove: [] }>();
const sourceOpen = ref(false);
const sourceMounted = ref(false);
const sourceButton = ref<HTMLButtonElement>();
const sourceId = useId();
const rules = computed(() => [
  { value: 'disabled' as const, label: lazyStrings.modelGraphDefinitionRegistry__register_only() },
  { value: 'when_architecture_unknown' as const, label: lazyStrings.modelGraphDefinitionRegistry__use_when_architecture_unknown() },
  { value: 'replace_native' as const, label: lazyStrings.modelGraphDefinitionRegistry__replace_native_implementation() },
]);

function toggleSource(): void {
  // Highlight only after inspection is requested, then retain the content for
  // the collapse animation and the person's scroll/wrapping preferences.
  sourceMounted.value = true;
  sourceOpen.value = !sourceOpen.value;
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <article tw-class="min-w-0 space-y-3 p-4" data-testid="model-graph-registration">
    <div tw-class="flex flex-wrap items-center justify-between gap-3">
      <div tw-class="min-w-0 flex-1 space-y-1"><h4 tw-class="break-words text-sm font-medium text-gray-700 dark:text-gray-300">{{ registration.label }}</h4><code v-if="registration.rule.mode !== 'disabled'" tw-class="break-all text-xs text-gray-500 dark:text-gray-400">{{ registration.rule.architecture }}</code></div>
      <div tw-class="flex shrink-0 items-center gap-2">
        <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="disabled" @click="emit('copy')" data-testid="model-graph-copy" :aria-label="lazyStrings.modelGraphDefinitionRegistry__copy_definitions()" :title="lazyStrings.modelGraphDefinitionRegistry__copy_definitions()"><CopyIcon aria-hidden="true" tw-class="h-4 w-4" /></ActionButton>
        <ActionButton appearance="primary" :icon-tone="undefined" :disabled="disabled" @click="emit('download')" data-testid="model-graph-download" :aria-label="lazyStrings.modelGraphDefinitionRegistry__download_json()" :title="lazyStrings.modelGraphDefinitionRegistry__download_json()"><DownloadIcon aria-hidden="true" tw-class="h-4 w-4" /></ActionButton>
        <ActionButton appearance="secondary" :icon-tone="undefined" :disabled="disabled || !hasInput" @click="emit('replace')" data-testid="model-graph-replace" :aria-label="lazyStrings.modelGraphDefinitionRegistry__replace_from_input()" :title="lazyStrings.modelGraphDefinitionRegistry__replace_from_input()"><ReplaceIcon aria-hidden="true" tw-class="h-4 w-4" /></ActionButton>
        <ActionButton appearance="danger" :icon-tone="undefined" :disabled="disabled" @click="emit('remove')" data-testid="model-graph-delete" :aria-label="lazyStrings.modelGraphDefinitionRegistry__delete_definition()" :title="lazyStrings.modelGraphDefinitionRegistry__delete_definition()"><Trash2Icon aria-hidden="true" tw-class="h-4 w-4" /></ActionButton>
      </div>
    </div>
    <div tw-class="space-y-1.5"><p tw-class="text-sm text-gray-600 dark:text-gray-400">{{ lazyStrings.modelGraphDefinitionRegistry__usage_rule() }}</p><SettingsFormSelect :model-value="registration.rule.mode" :options="rules" :label="lazyStrings.modelGraphDefinitionRegistry__usage_rule()" :disabled="disabled" data-testid="model-graph-usage-rule" tw-class="w-full text-sm!" @update:model-value="emit('rule', $event)" /></div>
    <div>
      <button ref="sourceButton" type="button" :disabled="disabled" @click="toggleSource" :aria-expanded="sourceOpen" :aria-controls="sourceId" data-testid="model-graph-source-toggle" tw-class="inline-flex max-w-full items-center gap-2 rounded-lg py-1 text-sm text-gray-500 transition-colors hover:text-blue-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-50 dark:text-gray-400 dark:hover:text-blue-400"><ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none', sourceOpen ? 'rotate-180' : '']" />{{ lazyStrings.modelGraphDefinitionRegistry__source() }}<code tw-class="text-xs text-gray-400 dark:text-gray-500">{{ registration.sourceSha256.slice(0, 12) }}</code></button>
      <SettingsCollapse :id="sourceId" :open="sourceOpen" :return-focus="sourceButton"><div tw-class="mt-2 max-h-80 overflow-auto"><StandardCodeBlock v-if="sourceMounted" :code="registration.source" lang="json" tw-class="my-0!" /></div></SettingsCollapse>
    </div>
  </article>
</template>
