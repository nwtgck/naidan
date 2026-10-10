<script setup lang="ts">
import { computed, nextTick, ref, useId, watch, type CSSProperties } from 'vue';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import type { ImageModelChoice } from '@/features/stable-diffusion-cpp-browser/library-view';
import ImageSettingsSection from '@/features/image-generation/components/ImageSettingsSection.vue';

// Pure local choices: opening/searching this picker never contacts a provider,
// reads model files, or changes the chat endpoint's settings.
const props = defineProps<{ label: string | undefined, modelValue: string, choices: readonly ImageModelChoice[], disabled: boolean, required: boolean, active: boolean, compact?: boolean, emptyLabel?: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId();
const search = ref('');
const open = ref(false);
const highlighted = ref(0);
const trigger = ref<HTMLButtonElement>();
const popup = ref<HTMLDivElement>();
const input = ref<HTMLInputElement>();
const list = ref<HTMLDivElement>();
const floatingStyle = ref<CSSProperties>({});
const selected = computed(() => props.choices.find(choice => choice.id === props.modelValue));
const emptyText = computed(() => props.emptyLabel || (props.required ? lazyStrings.stableDiffusionCppBrowser__select_component() : lazyStrings.ImageModelPicker__use_built_in_component()));
const matched = computed(() => {
  const terms = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return props.choices.filter(choice => terms.every(term => `${choice.label} ${choice.detail}`.toLocaleLowerCase().includes(term)));
});
const visible = computed(() => {
  // Keep the current selection inspectable even if the search does not match it.
  const current = selected.value;
  return current && !matched.value.includes(current) ? [current, ...matched.value] : matched.value;
});
const rows = computed(() => [
  { value: '', choice: undefined, disabled: false },
  ...visible.value.map(choice => ({ value: choice.id, choice, disabled: choice.status === 'incompatible' })),
]);
const highlightedRow = computed(() => rows.value[highlighted.value]);

function status({ choice }: { choice: ImageModelChoice }): string | undefined {
  switch (choice.status) {
  case 'matching': return lazyStrings.stableDiffusionCppBrowser__structural_match();
  case 'unverified': return lazyStrings.stableDiffusionCppBrowser__unverified_candidate();
  case 'incompatible': return lazyStrings.stableDiffusionCppBrowser__incompatible_candidate();
  default: { const exhaustive: never = choice.status; throw new Error(String(exhaustive)); }
  }
}

function place(): void {
  if (!trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 340), 640, Math.max(0, window.innerWidth - 24));
  const below = Math.max(0, window.innerHeight - rect.bottom - 16);
  const above = Math.max(0, rect.top - 16);
  const useAbove = below < 280 && above > below;
  floatingStyle.value = {
    position: 'fixed',
    left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(400, useAbove ? above : below)}px`,
    ...(useAbove ? { bottom: `${window.innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` }),
    zIndex: 9999,
  };
}

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  open.value = false;
  if (restoreFocus && props.active && !props.disabled) trigger.value?.focus();
}

async function show({ last }: { last: boolean }): Promise<void> {
  if (props.disabled || !props.active) return;
  search.value = '';
  open.value = true;
  const selectedIndex = rows.value.findIndex(row => row.value === props.modelValue && !row.disabled);
  highlighted.value = selectedIndex >= 0 ? selectedIndex : 0;
  if (last) highlighted.value = rows.value.findLastIndex(row => !row.disabled);
  place();
  await nextTick();
  if (!open.value || props.disabled || !props.active) return;
  input.value?.focus();
  scrollHighlighted();
}

function toggle(): void {
  if (open.value) close({ restoreFocus: false });
  else void show({ last: false });
}

function scrollHighlighted(): void {
  const option = document.getElementById(`${id}-option-${highlighted.value}`);
  if (!option || !list.value) return;
  const bounds = list.value.getBoundingClientRect();
  const item = option.getBoundingClientRect();
  if (item.top < bounds.top) list.value.scrollTop -= bounds.top - item.top;
  else if (item.bottom > bounds.bottom) list.value.scrollTop += item.bottom - bounds.bottom;
}

function move({ direction }: { direction: -1 | 1 }): void {
  for (let count = 1; count <= rows.value.length; count++) {
    const index = (highlighted.value + count * direction + rows.value.length) % rows.value.length;
    if (!rows.value[index]?.disabled) {
      highlighted.value = index;
      void nextTick(scrollHighlighted);
      break;
    }
  }
}

function choose({ value }: { value: string }): void {
  if (props.disabled || !props.active || !open.value) return;
  if (value && !props.choices.some(choice => choice.id === value && choice.status !== 'incompatible')) return;
  emit('update:modelValue', value);
  close({ restoreFocus: true });
}

function triggerKey({ event }: { event: KeyboardEvent }): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  void show({ last: event.key === 'ArrowUp' });
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing) return;
  switch (event.key) {
  case 'ArrowDown': event.preventDefault(); move({ direction: 1 }); break;
  case 'ArrowUp': event.preventDefault(); move({ direction: -1 }); break;
  case 'Home': event.preventDefault(); highlighted.value = 0; void nextTick(scrollHighlighted); break;
  case 'End': event.preventDefault(); highlighted.value = rows.value.findLastIndex(row => !row.disabled); void nextTick(scrollHighlighted); break;
  case 'Enter':
    event.preventDefault();
    if (highlightedRow.value) choose({ value: highlightedRow.value.value });
    break;
  case 'Escape': event.preventDefault(); event.stopPropagation(); close({ restoreFocus: true }); break;
  case 'Tab': close({ restoreFocus: true }); break; // Continue natural tab order from the trigger.
  }
}

function outside({ event }: { event: Event }): void {
  if (!open.value || !(event.target instanceof Node)) return;
  if (!trigger.value?.contains(event.target) && !popup.value?.contains(event.target)) close({ restoreFocus: false });
}

useEventTargetListener(document, 'pointerdown', event => outside({ event }), true);
useEventTargetListener(document, 'focusin', event => outside({ event }));
useEventTargetListener(document, 'toggle', event => {
  if (open.value && event.target instanceof HTMLDetailsElement && !event.target.open && trigger.value && event.target.contains(trigger.value)) close({ restoreFocus: false });
}, true);
useEventTargetListener(window, 'resize', () => {
  if (open.value) place();
});
useEventTargetListener(document, 'scroll', event => {
  if (open.value && (!(event.target instanceof Node) || !popup.value?.contains(event.target))) close({ restoreFocus: false });
}, true);
watch(() => [props.active, props.disabled], () => {
  if (!props.active || props.disabled) close({ restoreFocus: false });
});
watch(search, () => {
  highlighted.value = rows.value.findIndex(row => row.choice && !row.disabled && matched.value.includes(row.choice));
  if (highlighted.value < 0) highlighted.value = 0;
  if (list.value) list.value.scrollTop = 0;
}, { flush: 'sync' });
watch(rows, () => {
  if (!rows.value[highlighted.value] || rows.value[highlighted.value]?.disabled) highlighted.value = 0;
});

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="min-w-0 max-w-full space-y-2">
    <label :id="id + '-label'" :for="id" tw-class="block [overflow-wrap:anywhere] text-xs font-bold text-gray-700 dark:text-gray-200">{{ label }} <span v-if="required && !compact" tw-class="font-normal text-gray-400 dark:text-gray-500">· {{ lazyStrings.stableDiffusionCppBrowser__component_required() }}</span></label>
    <button ref="trigger" :id="id" type="button" :disabled="disabled || !active" :title="selected?.detail" :aria-labelledby="id + '-label ' + id + '-value'" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="open ? id + '-list' : undefined" @click="toggle()" @keydown="triggerKey({ event: $event })" data-testid="image-model-picker-trigger" tw-class="flex w-full min-w-0 min-h-11 items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2.5 text-left text-sm font-bold text-gray-800 dark:text-gray-100 shadow-sm transition-all hover:border-gray-300 dark:hover:border-gray-600 outline-none focus-visible:ring-4 focus-visible:ring-blue-500/10 disabled:opacity-50 disabled:cursor-not-allowed">
      <span :id="id + '-value'" tw-class="min-w-0 flex-1 truncate">{{ selected?.label || emptyText }}</span>
      <ChevronDownIcon aria-hidden="true" :tw-class="['h-4 w-4 shrink-0 text-gray-400 transition-transform', open ? 'rotate-180' : '']" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="popup" :style="floatingStyle" @keydown="keydown({ event: $event })" data-testid="image-model-picker-popup" tw-class="flex min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 shadow-xl">
        <div tw-class="shrink-0 border-b border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/50 p-2">
          <div tw-class="relative">
            <SearchIcon aria-hidden="true" tw-class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input ref="input" v-model="search" type="search" role="combobox" aria-autocomplete="list" aria-expanded="true" :aria-controls="id + '-list'" :aria-activedescendant="highlightedRow ? id + '-option-' + highlighted : undefined" :aria-label="lazyStrings.ImageModelPicker__search_choices()" :placeholder="lazyStrings.ImageModelPicker__search_choices()" data-testid="image-model-picker-search" tw-class="min-h-11 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2 pl-9 pr-3 text-sm shadow-sm outline-none focus:border-blue-400 focus:ring-4 focus:ring-blue-500/10 placeholder:text-gray-400" />
          </div>
        </div>
        <div ref="list" :id="id + '-list'" role="listbox" :aria-labelledby="id + '-label'" data-testid="image-model-picker-list" tw-class="min-h-0 overflow-y-auto overscroll-contain p-1">
          <button v-for="(row, index) in rows" :key="row.value" :id="id + '-option-' + index" type="button" role="option" tabindex="-1" :aria-selected="row.value === modelValue" :aria-disabled="row.disabled" :disabled="row.disabled" :data-value="row.value" data-testid="image-model-picker-option" @pointerdown.prevent @click="choose({ value: row.value })" @mouseenter="!row.disabled && (highlighted = index)" :tw-class="['flex w-full min-w-0 min-h-11 items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none disabled:cursor-not-allowed disabled:opacity-50', highlighted === index ? 'bg-blue-50 dark:bg-blue-950/40' : 'hover:bg-gray-50 dark:hover:bg-gray-800/60']">
            <span tw-class="min-w-0 flex-1 space-y-1">
              <span :tw-class="['block [overflow-wrap:anywhere] text-sm', row.value === modelValue ? 'font-medium text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-100']">{{ row.choice?.label || emptyText }}</span>
              <template v-if="row.choice">
                <span tw-class="block break-all text-xs text-gray-500 dark:text-gray-400">{{ row.choice.detail }}</span>
                <span :tw-class="['block text-xs', row.choice.status === 'matching' ? 'text-gray-500 dark:text-gray-400' : 'text-amber-700 dark:text-amber-400']">{{ status({ choice: row.choice }) }}</span>
                <span v-if="row.choice.issue" tw-class="block [overflow-wrap:anywhere] text-xs text-red-600 dark:text-red-400">{{ row.choice.issue }}</span>
              </template>
            </span>
            <CheckIcon v-if="row.value === modelValue" aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          </button>
          <p v-if="!matched.length" role="status" data-testid="image-model-picker-empty" tw-class="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">{{ lazyStrings.ModelSelector__no_models_found() }}</p>
        </div>
      </div>
    </Teleport>
    <p v-if="!compact && selected && selected.status !== 'matching'" tw-class="text-xs text-amber-700 dark:text-amber-400">{{ status({ choice: selected }) }}</p>
    <p v-if="!compact && selected?.issue" role="alert" tw-class="[overflow-wrap:anywhere] text-xs text-red-600 dark:text-red-400">{{ selected.issue }}</p>
    <ImageSettingsSection v-if="selected && !compact" embedded :title="lazyStrings.llamaCppBrowserDownloads__details()" :summary="status({ choice: selected })" data-testid="image-component-details">
      <div tw-class="min-w-0 space-y-2 [overflow-wrap:anywhere] text-xs text-gray-500 dark:text-gray-400">
        <p tw-class="break-all font-mono">{{ selected.detail }}</p>
        <p>{{ status({ choice: selected }) }}</p>
        <p v-for="reason in selected.evidence" :key="reason">{{ reason }}</p>
      </div>
    </ImageSettingsSection>
  </div>
</template>
