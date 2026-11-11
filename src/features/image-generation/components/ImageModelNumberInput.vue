<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ChevronDownIcon } from 'lucide-vue-next';
import MessageActionsMenu from '@/components/MessageActionsMenu.vue';
import type { ImageModelParameterPreference } from '@/01-models/image-generation';
import { lazyStrings } from '@/strings';

const props = defineProps<{ id: string, label: string | undefined, preference: ImageModelParameterPreference, value: number, minimum: number, maximum: number, step: number, origin: 'recommended' | 'standard' | undefined, disabled: boolean, inputTestId: string }>();
const emit = defineEmits<{ change: [preference: ImageModelParameterPreference] }>();
const open = ref(false), trigger = ref<HTMLButtonElement>(), action = ref<HTMLButtonElement>();
const automatic = computed(() => props.preference === 'auto');
const preferenceLabel = computed(() => {
  const field = props.label;
  const mode = automatic.value ? lazyStrings.ImageModelNumberInput__automatic() : lazyStrings.ImageModelNumberInput__fixed();
  return field && mode ? `${field}: ${mode}` : undefined;
});
const displayValue = computed(() => {
  const value = typeof props.preference === 'number' ? props.preference : props.value;
  return Number.isFinite(value) ? value : '';
});
const originLabel = computed(() => {
  switch (props.origin) {
  case 'recommended': return lazyStrings.ImageModelNumberInput__model_recommended_value();
  case 'standard': return lazyStrings.ImageModelNumberInput__naidan_standard_value();
  case undefined: return undefined;
  default: {
    const exhaustive: never = props.origin;
    throw new Error(String(exhaustive));
  }
  }
});
watch(() => [props.preference, props.value, props.disabled], () => {
  open.value = false;
}, { flush: 'sync' });

function change({ event }: { event: Event }): void {
  if (props.disabled || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  // Editing fixes the value even when it equals the current automatic value.
  // Merely focusing the field leaves the model-following preference untouched.
  emit('change', event.target.value.trim() ? Number(event.target.value) : NaN);
}

async function openMenu(): Promise<void> {
  if (props.disabled) {
    return;
  }
  open.value = true;
  await nextTick();
  if (open.value) {
    action.value?.focus({ preventScroll: true });
  }
}

function close(): void {
  open.value = false;
  trigger.value?.focus({ preventScroll: true });
}

function matchModel(): void {
  if (props.disabled) {
    return;
  }
  emit('change', 'auto');
  close();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div tw-class="space-y-1">
    <div tw-class="flex items-center gap-1 rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-gray-50/60 dark:bg-gray-800/40 pr-1.5 transition-colors hover:border-blue-200/80 dark:hover:border-blue-500/35 focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-500/10">
      <input :id="id" :value="displayValue" :disabled="disabled" :data-testid="inputTestId" type="number" :min="minimum" :max="maximum" :step="step" :aria-describedby="automatic && origin ? id + '-origin' : undefined" required @input="change({ event: $event })" tw-class="block min-w-0 w-full rounded-l-xl border-0 bg-transparent p-2.5 text-gray-800 dark:text-gray-100 outline-none disabled:opacity-50" />
      <button ref="trigger" type="button" :disabled="disabled" :aria-label="preferenceLabel" :aria-expanded="open" :aria-controls="id + '-preference-menu'" aria-haspopup="menu" :data-testid="inputTestId + '-preference'" @click="open ? close() : openMenu()" @keydown.down.stop.prevent="openMenu" @keydown.esc.stop.prevent="close" tw-class="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">
        {{ automatic ? lazyStrings.ImageModelNumberInput__automatic() : lazyStrings.ImageModelNumberInput__fixed() }}<ChevronDownIcon aria-hidden="true" tw-class="h-3 w-3" />
      </button>
      <MessageActionsMenu v-if="trigger" :is-open="open" :trigger-el="trigger" :width="208" @close="open = false">
        <div :id="id + '-preference-menu'" role="menu" @keydown.esc.stop.prevent="close">
          <button ref="action" type="button" role="menuitemradio" :aria-checked="automatic" :disabled="disabled" :data-testid="inputTestId + '-match-model'" @click="matchModel" tw-class="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:opacity-40">{{ lazyStrings.ImageModelNumberInput__match_model() }}</button>
        </div>
      </MessageActionsMenu>
    </div>
    <p v-if="automatic && origin" :id="id + '-origin'" :data-testid="inputTestId + '-origin'" tw-class="text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ originLabel }}</p>
  </div>
</template>
