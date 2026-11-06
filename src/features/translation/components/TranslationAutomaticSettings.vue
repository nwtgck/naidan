<script setup lang="ts">
import { inject, nextTick, ref, useId, watch, type Ref } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { SlidersHorizontalIcon } from 'lucide-vue-next';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { automaticTranslationDelay, automaticTranslationSettings } from '@/features/translation/automatic-settings';
import { lazyStrings } from '@/strings';

const props = defineProps<{ debounceMs: number, disabled: boolean }>();
const emit = defineEmits<{ change: [delay: number] }>();
const id = useId();
const active = inject<Readonly<Ref<boolean>> | undefined>('settings-disclosure-open', undefined);
const trigger = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement>();
const open = ref(false);
const popup = useAnchoredPopup({ anchor: trigger, preferredWidth: { unit: 'rem', value: 20 }, maxWidthPx: 400, preferredPlacement: { direction: 'top', minHeightPx: 160 } });

function close({ restore }: { restore: boolean }): void {
  open.value = false;
  if (restore) {
    trigger.value?.focus();
  }
}

async function toggle(): Promise<void> {
  if (props.disabled || active?.value === false) {
    return;
  }
  if (open.value) {
    close({ restore: false });
    return;
  }
  popup.refresh();
  open.value = true;
  await nextTick();
  if (open.value) {
    popup.refresh();
    input.value?.focus();
  }
}

function change({ event }: { event: Event }): void {
  if (!(event.target instanceof HTMLInputElement) || props.disabled || !open.value || active?.value === false) {
    return;
  }
  const value = event.target.valueAsNumber;
  if (!Number.isFinite(value)) {
    event.target.value = String(props.debounceMs);
    return;
  }
  const next = automaticTranslationSettings({ value: { debounceMs: value } }).debounceMs;
  event.target.value = String(props.debounceMs);
  if (next !== props.debounceMs) {
    emit('change', next);
  }
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close({ restore: true });
  } else if (event.key === 'Tab') {
    close({ restore: true });
  } else if (event.key === 'Enter') {
    event.preventDefault();
    change({ event });
    close({ restore: true });
  }
}

watch([() => props.disabled, () => active?.value], () => {
  if (props.disabled || active?.value === false) {
    close({ restore: false });
  }
});
onClickOutside(trigger, () => close({ restore: false }), { ignore: [panel] });
useEventTargetListener(document, 'focusin', event => {
  if (event.target instanceof Node && open.value && !trigger.value?.contains(event.target) && !panel.value?.contains(event.target)) {
    close({ restore: false });
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <button ref="trigger" type="button" :disabled="disabled" :aria-label="lazyStrings.translation__automatic_translation_settings()" :title="lazyStrings.translation__automatic_translation_settings()" :aria-expanded="open" :aria-controls="open ? id : undefined" aria-haspopup="dialog" data-testid="translation-auto-settings" tw-class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-45 dark:hover:bg-gray-800 dark:hover:text-gray-200" @click="toggle"><SlidersHorizontalIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /></button>
  <Teleport to="body">
    <section v-if="open" :id="id" ref="panel" role="dialog" :aria-label="lazyStrings.translation__automatic_translation_settings()" :style="popup.placement.value.style" tw-class="overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900" data-testid="translation-auto-settings-panel" @keydown="keydown({ event: $event })">
      <label :for="`${id}-delay`" tw-class="mb-3 block text-xs font-medium text-gray-600 dark:text-gray-300">{{ lazyStrings.translation__delay_after_editing_ms() }}</label>
      <input :id="`${id}-delay`" ref="input" :value="debounceMs" type="number" :min="automaticTranslationDelay.minimum" :max="automaticTranslationDelay.maximum" :step="automaticTranslationDelay.step" inputmode="numeric" data-testid="translation-debounce" tw-class="w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-gray-700 dark:bg-gray-800/40 dark:text-gray-100" @change="change({ event: $event })" />
    </section>
  </Teleport>
</template>
