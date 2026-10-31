<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

const props = defineProps<{ open: boolean, onboarding: boolean }>();
const emit = defineEmits<{ close: [] }>();
const headingId = useId();
const dialog = ref<HTMLElement>();
const closeButton = ref<HTMLButtonElement>();
let previouslyFocused: HTMLElement | undefined;

function restoreFocus(): void {
  if (previouslyFocused?.isConnected) {
    previouslyFocused.focus({ preventScroll: true });
  }
  previouslyFocused = undefined;
}

watch(() => props.open, async open => {
  if (open) {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    await nextTick();
    if (props.open) {
      closeButton.value?.focus({ preventScroll: true });
    }
  } else {
    await nextTick();
    if (!props.open) {
      restoreFocus();
    }
  }
});
onBeforeUnmount(restoreFocus);

function canFocus({ element }: { element: HTMLElement }): boolean {
  if (element.tabIndex < 0 || element.matches(':disabled, [type="hidden"]') || element.closest('[inert], [hidden], [aria-hidden="true"]')) {
    return false;
  }
  let ancestor: HTMLElement | undefined = element;
  while (ancestor && ancestor !== dialog.value) {
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open && !ancestor.querySelector('summary')?.contains(element)) {
      return false;
    }
    const style = getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden') {
      return false;
    }
    ancestor = ancestor.parentElement ?? undefined;
  }
  return true;
}

function keydown({ event }: { event: KeyboardEvent }): void {
  // A nested selector handles its own Escape before the dialog does. This also
  // avoids closing the panel when Escape only cancels IME composition.
  if (!props.open || event.defaultPrevented || event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  const candidates = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex="0"]') ?? []).filter(element => canFocus({ element }));
  const first = candidates[0];
  const last = candidates.at(-1);
  if (!first) {
    event.preventDefault();
    dialog.value?.focus();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.value)) {
    event.preventDefault();
    first.focus();
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <!-- Keep one catalog/manager mounted. Teleport moves the same settings DOM
       between first-use setup and a ChatSettingsPanel-style modal. -->
  <Teleport to="body" :disabled="onboarding && !open">
    <div v-show="onboarding || open" :tw-class="open ? 'fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-2 backdrop-blur-[2px] md:p-6' : ''" @click.self="open && emit('close')" @keydown="keydown({ event: $event })" data-testid="live-settings-surface">
      <section ref="dialog" :role="open ? 'dialog' : undefined" :aria-modal="open ? true : undefined" :aria-labelledby="open ? headingId : undefined" tabindex="-1" :tw-class="open ? 'relative flex max-h-[90dvh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl outline-none dark:border-gray-800 dark:bg-gray-900' : 'min-w-0'" data-testid="live-settings">
        <header v-if="open" tw-class="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200/70 px-5 py-3 dark:border-gray-800">
          <h2 :id="headingId" tw-class="min-w-0 truncate text-sm font-semibold text-gray-800 dark:text-gray-100">{{ lazyStrings.liveConversation__conversation_settings() }}</h2>
          <button ref="closeButton" type="button" @click="emit('close')" :aria-label="lazyStrings.liveConversation__close_settings()" :title="lazyStrings.liveConversation__close_settings()" tw-class="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:hover:bg-gray-800 dark:hover:text-gray-100" data-testid="live-settings-close"><XIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
        </header>
        <div :tw-class="open ? 'min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-6' : 'space-y-5'" data-testid="live-settings-body"><slot /></div>
      </section>
    </div>
  </Teleport>
</template>
