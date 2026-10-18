<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useId, nextTick } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { InfoIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';

const buttonRef = ref<HTMLButtonElement | null>(null);
const tooltipRef = ref<HTMLElement | null>(null);
const helpId = useId();
const visibility = ref<'closed' | 'transient' | 'pinned'>('closed');
const hovered = ref(false);
const popup = useAnchoredPopup({ anchor: buttonRef, preferredWidth: { unit: 'rem', value: 22 }, maxWidthPx: 360 });
const style = computed(() => ({ ...popup.placement.value.style, zIndex: 10001 }));
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function cancelHide() {
  clearTimeout(hideTimer);
}

function showHelp() {
  cancelHide();
  const current = visibility.value;
  switch (current) {
  case 'closed':
    visibility.value = 'transient';
    popup.refresh();
    void nextTick(popup.refresh);
    break;
  case 'transient':
  case 'pinned':
    break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled help visibility: ${_ex}`);
  }
  }
}

function leaveHelp() {
  cancelHide();
  // Allow the pointer to cross the gap into the teleported explanation.
  hideTimer = setTimeout(() => {
    if (visibility.value === 'transient' && !hovered.value && document.activeElement !== buttonRef.value) {
      visibility.value = 'closed';
    }
  }, 100);
}

function closeHelp() {
  cancelHide();
  visibility.value = 'closed';
  hovered.value = false;
}

function toggleHelp() {
  cancelHide();
  const current = visibility.value;
  switch (current) {
  case 'closed':
  case 'transient':
    visibility.value = 'pinned';
    popup.refresh();
    void nextTick(popup.refresh);
    break;
  case 'pinned':
    closeHelp();
    break;
  default: {
    const _ex: never = current;
    throw new Error(`Unhandled help visibility: ${_ex}`);
  }
  }
}

function handleKeydown({ event }: { event: KeyboardEvent }) {
  if (event.key === 'Escape' && visibility.value !== 'closed') {
    event.preventDefault();
    event.stopPropagation();
    closeHelp();
  }
}

onClickOutside(buttonRef, closeHelp, { ignore: [tooltipRef] });
onBeforeUnmount(cancelHide);


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      // ESLint-required for defineExpose.
    },
  }) || {}),
});
</script>

<template>
  <button
    ref="buttonRef"
    type="button"
    data-testid="reasoning-help-button"
    tw-class="p-1 -m-1 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400/50"
    :aria-label="lazyStrings.ReasoningSettings__effort_levels_may_be_ignored_by_some_models()"
    :aria-expanded="visibility !== 'closed'"
    :aria-controls="helpId"
    :aria-describedby="visibility !== 'closed' ? helpId : undefined"
    @mouseenter="showHelp"
    @mouseleave="leaveHelp"
    @focus="showHelp"
    @blur="leaveHelp"
    @click="toggleHelp"
    @keydown="handleKeydown({ event: $event })"
  >
    <InfoIcon tw-class="w-3.5 h-3.5" />
  </button>
  <Teleport to="body">
    <div
      v-if="visibility !== 'closed'"
      :id="helpId"
      ref="tooltipRef"
      role="tooltip"
      data-testid="reasoning-help"
      :style="style"
      tw-class="px-3 py-2 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 shadow-xl text-xs text-gray-600 dark:text-gray-300 leading-relaxed overflow-y-auto overscroll-contain"
      @mouseenter="hovered = true; cancelHide()"
      @mouseleave="hovered = false; leaveHelp()"
      @mousedown.prevent.stop
      @click.stop
    >
      {{ lazyStrings.ReasoningSettings__effort_levels_may_be_ignored_by_some_models() }}
    </div>
  </Teleport>
</template>
