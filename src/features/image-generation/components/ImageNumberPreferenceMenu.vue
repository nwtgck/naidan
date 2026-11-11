<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { CheckIcon } from 'lucide-vue-next';
import MessageActionsMenu from '@/components/MessageActionsMenu.vue';
import type { ImageModelParameterPreference } from '@/01-models/image-generation';
import { lazyStrings } from '@/strings';

const props = defineProps<{ id: string, open: boolean, trigger: HTMLButtonElement, label: string | undefined, preference: ImageModelParameterPreference, value: number, disabled: boolean, automaticLabel: string | undefined, fixedLabel: string | undefined, automaticTestId: string, fixedTestId: string }>();
const emit = defineEmits<{ select: [preference: ImageModelParameterPreference], close: [], dismiss: [] }>();
const automaticAction = ref<HTMLButtonElement>(), fixedAction = ref<HTMLButtonElement>();
const automatic = computed(() => props.preference === 'auto');
const currentValue = computed(() => typeof props.preference === 'number' ? props.preference : props.value);
const canFix = computed(() => !props.disabled && Number.isFinite(currentValue.value));

watch(() => [props.open, props.disabled], async () => {
  if (!props.open || props.disabled) {
    return;
  }
  await nextTick();
  if (props.open && !props.disabled) {
    // Start at the selected choice. An invalid fixed edit can always return to
    // automatic, without offering to pin an empty or non-finite number.
    (automatic.value || !canFix.value ? automaticAction.value : fixedAction.value)?.focus({ preventScroll: true });
  }
}, { flush: 'post', immediate: true });

function select({ mode }: { mode: 'auto' | 'fixed' }): void {
  if (!props.open || props.disabled) {
    return;
  }
  switch (mode) {
  case 'auto': emit('select', 'auto');
    break;
  case 'fixed':
    if (!canFix.value) {
      return;
    }
    emit('select', currentValue.value);
    break;
  default: {
    const exhaustive: never = mode;
    throw new Error(String(exhaustive));
  }
  }
  emit('close');
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (!props.open || props.disabled) {
    return;
  }
  const key = event.key;
  switch (key) {
  case 'Escape':
    event.preventDefault();
    event.stopPropagation();
    emit('close');
    return;
  case 'Tab':
    // Restore the trigger before the browser performs normal forward/backward
    // tab navigation; the teleported menu is not part of the form's tab order.
    emit('close');
    return;
  case 'ArrowDown': case 'ArrowUp': case 'Home': case 'End': {
    event.preventDefault();
    event.stopPropagation();
    const actions = [automaticAction.value, ...(canFix.value ? [fixedAction.value] : [])].filter((action): action is HTMLButtonElement => action !== undefined);
    if (!actions.length) {
      return;
    }
    const current = actions.findIndex(action => action === document.activeElement);
    const index = (() => {
      switch (key) {
      case 'Home': return 0;
      case 'End': return actions.length - 1;
      case 'ArrowDown': return (current + 1) % actions.length;
      case 'ArrowUp': return current < 0 ? actions.length - 1 : (current - 1 + actions.length) % actions.length;
      default: {
        const exhaustive: never = key;
        throw new Error(String(exhaustive));
      }
      }
    })();
    actions[index]?.focus({ preventScroll: true });
    return;
  }
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <MessageActionsMenu :is-open="open" :trigger-el="trigger" :width="240" @close="emit('dismiss')">
    <div :id="id" role="menu" :aria-label="label" @keydown="keydown({ event: $event })">
      <button ref="automaticAction" type="button" role="menuitemradio" tabindex="-1" :aria-checked="automatic" :aria-labelledby="id + '-automatic-label'" :aria-describedby="id + '-automatic-description'" :disabled="disabled" :data-testid="automaticTestId" @click="select({ mode: 'auto' })" tw-class="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:opacity-40">
        <span aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0"><CheckIcon v-if="automatic" :data-testid="automaticTestId + '-selected'" tw-class="h-4 w-4 text-blue-600 dark:text-blue-400" /></span>
        <span tw-class="min-w-0 space-y-0.5"><span :id="id + '-automatic-label'" :data-testid="automaticTestId + '-label'" tw-class="block font-medium">{{ automaticLabel }}</span><span :id="id + '-automatic-description'" :data-testid="automaticTestId + '-description'" tw-class="block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageNumberPreferenceMenu__change_with_model() }}</span></span>
      </button>
      <button ref="fixedAction" type="button" role="menuitemradio" tabindex="-1" :aria-checked="!automatic" :aria-labelledby="id + '-fixed-label'" :aria-describedby="id + '-fixed-description'" :disabled="!canFix" :data-testid="fixedTestId" @click="select({ mode: 'fixed' })" tw-class="flex w-full items-start gap-2 px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500 disabled:opacity-40">
        <span aria-hidden="true" tw-class="mt-0.5 h-4 w-4 shrink-0"><CheckIcon v-if="!automatic" :data-testid="fixedTestId + '-selected'" tw-class="h-4 w-4 text-blue-600 dark:text-blue-400" /></span>
        <span tw-class="min-w-0 space-y-0.5"><span :id="id + '-fixed-label'" :data-testid="fixedTestId + '-label'" tw-class="block font-medium">{{ fixedLabel }}</span><span :id="id + '-fixed-description'" :data-testid="fixedTestId + '-description'" tw-class="block text-xs leading-relaxed text-gray-500 dark:text-gray-400">{{ lazyStrings.ImageNumberPreferenceMenu__keep_using_this_number() }}</span></span>
      </button>
    </div>
  </MessageActionsMenu>
</template>
