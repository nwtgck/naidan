<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { lazyStrings } from '@/strings';
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
import LlamaCppBrowserManager from '@/features/llama-cpp-browser/components/LlamaCppBrowserManager.vue';
import LlamaCppBrowserModelActionButton from '@/features/llama-cpp-browser/components/LlamaCppBrowserModelActionButton.vue';
import { translationModelSuggestions } from '@/features/translation/model-catalog';
const props = defineProps<{ suspended: boolean, disabled: boolean, modelId: string | undefined }>();
const emit = defineEmits<{ select: [modelId: string], changed: [] }>();
const id = useId();
const tab = ref<'catalog' | 'repository' | 'local'>('catalog');
const tablist = ref<HTMLElement>();
const content = ref<HTMLElement>();
const tabs = computed(() => [
  { value: 'catalog' as const, label: lazyStrings.translation__candidate_models() },
  { value: 'repository' as const, label: 'Hugging Face' },
  { value: 'local' as const, label: lazyStrings.translation__models_on_your_device() },
]);
const activeScope = ref(true);

async function choose({ value }: { value: typeof tab.value }): Promise<void> {
  if (props.suspended || tab.value === value) {
    return;
  }
  // Close teleported selects belonging to the old pane before exposing the new one.
  activeScope.value = false;
  tab.value = value;
  if (content.value) {
    content.value.scrollTop = 0;
  }
  await nextTick();
  activeScope.value = true;
}

async function keydown({ event }: { event: KeyboardEvent }): Promise<void> {
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) {
    return;
  }
  const index = tabs.value.findIndex(entry => entry.value === tab.value);
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.value.length
    : event.key === 'ArrowLeft' ? (index - 1 + tabs.value.length) % tabs.value.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : undefined;
  if (next === undefined) {
    return;
  }
  event.preventDefault();
  await choose({ value: tabs.value[next]!.value });
  tablist.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <section data-testid="translation-models" tw-class="flex h-full min-h-0 flex-col">
    <div ref="tablist" role="tablist" tabindex="-1" :aria-label="lazyStrings.translation__translation_models()" tw-class="flex shrink-0 gap-4 border-b border-gray-100 dark:border-gray-800 sm:gap-6" @keydown="keydown({ event: $event })">
      <button v-for="entry in tabs" :id="`${id}-${entry.value}`" :key="entry.value" :title="entry.label" type="button" role="tab" :tabindex="tab === entry.value ? 0 : -1" :aria-selected="tab === entry.value" :aria-controls="`${id}-content`" :data-testid="`translation-model-tab-${entry.value}`" :tw-class="['min-h-11 min-w-0 flex-1 truncate whitespace-nowrap border-b-2 sm:flex-none px-0.5 pb-3 pt-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-blue-500', tab === entry.value ? 'border-blue-500 text-blue-600 dark:text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-700 dark:hover:text-gray-200']" @click="choose({ value: entry.value })">{{ entry.label }}</button>
    </div>
    <!-- One scrolling owner, shared by all tabs. At its edge, wheel/touch input
         chains to the page. The catalog's rows never capture it a second time. -->
    <div :id="`${id}-content`" ref="content" role="tabpanel" :aria-labelledby="`${id}-${tab}`" tabindex="0" data-testid="translation-model-tab-content" tw-class="min-h-0 flex-1 overflow-y-auto overscroll-auto pt-4 pr-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/30">
      <SettingsSelectScope :active="!suspended && activeScope" :return-focus="tablist">
        <LlamaCppBrowserManager presentation="settings" :model-suggestions="translationModelSuggestions" :catalog-first="true" :model-view="tab" scroll-owner="parent" runtime-settings="hide" selection-action="select" :suspended="props.suspended" :disabled="props.disabled" @model-selected="emit('select', $event)" @models-changed="emit('changed')">
          <template #model-actions="{ model, disabled }"><LlamaCppBrowserModelActionButton :disabled="disabled || props.disabled || props.suspended" :aria-pressed="model.modelId === props.modelId" :data-testid="`translation-select-${model.modelId}`" @click="emit('select', model.modelId)">{{ model.modelId === props.modelId ? lazyStrings.translation__selected_model() : lazyStrings.translation__use_for_translation() }}</LlamaCppBrowserModelActionButton></template>
          <template #selection-hint><p tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.translation__model_selection_help() }}</p></template>
        </LlamaCppBrowserManager>
      </SettingsSelectScope>
    </div>
  </section>
</template>
