<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, useTemplateRef } from 'vue';
import { onClickOutside } from '@vueuse/core';
import { InfoIcon } from 'lucide-vue-next';
import { useAnchoredPopup } from '@/composables/useAnchoredPopup';
import { useEventTargetListener } from '@/composables/useEventTargetListener';
import { lazyStrings } from '@/strings';

const buttonRef = useTemplateRef<HTMLButtonElement>('helpButton');
const explanationRef = useTemplateRef<HTMLElement>('explanation');
const helpId = useId();
const visibility = ref<'closed' | 'transient' | 'pinned'>('closed');
const hovered = ref(false);
const popup = useAnchoredPopup({ anchor: buttonRef, preferredWidth: { unit: 'rem', value: 22 }, maxWidthPx: undefined });
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
    throw new Error(`Unhandled portable edition help visibility: ${_ex}`);
  }
  }
}

function leaveHelp() {
  cancelHide();
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
    throw new Error(`Unhandled portable edition help visibility: ${_ex}`);
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

onClickOutside(buttonRef, closeHelp, { ignore: [explanationRef] });
useEventTargetListener(document, 'keydown', event => handleKeydown({ event }), { capture: true });
onBeforeUnmount(cancelHide);

defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <button
    ref="helpButton"
    type="button"
    data-testid="portable-html-help-button"
    :aria-label="lazyStrings.AboutPortableEditionHelp__how_to_use_the_portable_html_edition()"
    :aria-expanded="visibility !== 'closed'"
    :aria-controls="helpId"
    :aria-describedby="visibility !== 'closed' ? helpId : undefined"
    tw-class="inline-flex h-7 w-7 items-center justify-center rounded-lg text-green-600 transition-colors hover:bg-green-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500/40 dark:text-green-400 dark:hover:bg-green-500/15 motion-reduce:transition-none"
    @mouseenter="showHelp"
    @mouseleave="leaveHelp"
    @focus="showHelp"
    @blur="leaveHelp"
    @click="toggleHelp"
  >
    <InfoIcon aria-hidden="true" tw-class="h-4 w-4" />
  </button>
  <Teleport to="body">
    <div
      v-if="visibility !== 'closed'"
      :id="helpId"
      ref="explanation"
      role="tooltip"
      data-testid="portable-html-help"
      :style="{ ...popup.placement.value.style, zIndex: 10001 }"
      tw-class="overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs leading-relaxed text-gray-600 shadow-xl dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
      @mouseenter="hovered = true; cancelHide()"
      @mouseleave="hovered = false; leaveHelp()"
    >
      {{ lazyStrings.SHARED__extract_the_zip_and_open_index_html_no_http_server_required() }}
    </div>
  </Teleport>
</template>
