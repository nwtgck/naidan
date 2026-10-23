<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';

// Keep this shell synchronous: it must paint before Sidebar and ChatPane.
// Action-only views and execution modules belong to the dialog owner.
const props = defineProps<{
  open: boolean,
  dismissible: boolean,
  suspended: boolean,
}>();
const emit = defineEmits<{ close: [], closed: [] }>();
const panel = ref<HTMLElement>();

watch(() => props.open, async open => {
  if (open) {
    await nextTick();
    if (props.open) {
      panel.value?.focus({ preventScroll: true });
    }
  }
}, { immediate: true });

function afterLeave(): void {
  emit('closed');
}

function close(): void {
  if (props.dismissible && props.open && !props.suspended) {
    emit('close');
  }
}

function keydown({ event }: { event: KeyboardEvent }): void {
  if (!props.open || props.suspended) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  if (event.key !== 'Tab') {
    return;
  }
  const elements = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled):not([tabindex="-1"]), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]') ?? [])
    .filter(element => !element.closest('[inert], [hidden], [aria-hidden="true"]'));
  const first = elements[0];
  const last = elements.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
  } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) {
    event.preventDefault();
    first.focus();
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <Teleport to="body">
    <Transition name="browser-model-dialog" appear :duration="{ enter: 480, leave: 180 }" @after-leave="afterLeave">
      <div v-if="open" class="browser-model-dialog browser-model-dialog-active" data-testid="browser-model-dialog" tw-class="h-full min-h-0">
        <div class="browser-model-dialog-backdrop" aria-hidden="true" tw-class="absolute inset-0 bg-gray-950/35 backdrop-blur-[6px] dark:bg-black/50" @click="close" />
        <section ref="panel" class="browser-model-dialog-panel" role="dialog" :aria-modal="!suspended || undefined" :aria-hidden="suspended || undefined" :inert="suspended || undefined" :aria-label="lazyStrings.BrowserModelWelcome__choose_a_model()" tabindex="-1" tw-class="relative flex h-full min-h-0 flex-col bg-[#fcfcfd] outline-none dark:bg-gray-900" @keydown="keydown({ event: $event })">
          <button type="button" class="browser-model-dialog-close" :disabled="!dismissible || suspended" :aria-label="lazyStrings.BrowserModelDialog__close()" data-testid="browser-model-dialog-close" tw-class="absolute right-3 top-3 z-30 grid h-9 w-9 place-items-center rounded-xl text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-30 dark:hover:bg-gray-800 dark:hover:text-gray-200 sm:right-4 sm:top-4" @click="close"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
          <div class="browser-model-dialog-content" tw-class="relative min-h-0 flex-1">
            <slot />
          </div>
          <slot name="overlay" />
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.browser-model-dialog-active {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100dvh;
  padding: 28px;
  isolation: isolate;
}
.browser-model-dialog-active .browser-model-dialog-panel {
  width: min(100%, 1120px);
  height: min(100%, 840px);
  overflow: hidden;
  border: 1px solid rgb(148 163 184 / 0.18);
  border-radius: 24px;
  box-shadow: 0 32px 100px -24px rgb(15 23 42 / 0.4), 0 0 0 1px rgb(255 255 255 / 0.05) inset;
  animation: browser-model-dialog-arrive 480ms cubic-bezier(0.22, 1, 0.36, 1) both;
}
.browser-model-dialog-active .browser-model-dialog-panel:where(.dark *) {
  box-shadow: 0 32px 120px -24px rgb(0 0 0 / 0.75), 0 0 0 1px rgb(255 255 255 / 0.025) inset;
}
.browser-model-dialog-active .browser-model-dialog-backdrop {
  animation: browser-model-dialog-veil 360ms ease both;
}
.browser-model-dialog-leave-active .browser-model-dialog-panel {
  animation: browser-model-dialog-depart 180ms ease both;
}
.browser-model-dialog-leave-active .browser-model-dialog-backdrop {
  animation: browser-model-dialog-veil 180ms ease reverse both;
}
.browser-model-dialog-active .browser-model-dialog-content {
  overflow: auto;
  overscroll-behavior: contain;
}
.browser-model-dialog-active :deep(.browser-model-welcome) {
  --welcome-gutter: clamp(1rem, 3vw, 3rem);
  padding-top: clamp(4.25rem, 9dvh, 5.5rem);
  padding-bottom: 1.5rem;
}
.browser-model-dialog-active :deep(.onboarding-content) {
  gap: clamp(1rem, 3dvh, 1.75rem);
}
.browser-model-dialog-active :deep(.onboarding-language) {
  top: 1.125rem;
  right: 4rem;
}
.browser-model-dialog-active :deep(.onboarding-benefit) {
  animation: browser-model-benefit-appear 800ms cubic-bezier(0.22, 1, 0.36, 1) 160ms both;
}
.browser-model-dialog-active :deep(.onboarding-benefits > .onboarding-benefit:nth-child(2)) {
  animation-delay: 300ms;
}
.browser-model-dialog-active :deep(.onboarding-benefits > span:last-child > .onboarding-benefit:first-child) {
  animation-delay: 440ms;
}
.browser-model-dialog-active :deep(.onboarding-benefits > span:last-child > .onboarding-benefit:last-child) {
  animation-delay: 580ms;
}
.browser-model-dialog-active :deep(.onboarding-local-files) {
  animation: browser-model-files-hint-appear 1000ms cubic-bezier(0.22, 1, 0.36, 1) 420ms both;
}
.browser-model-dialog-active :deep(.browser-model-step-enter-active) {
  transition: opacity 220ms ease, transform 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.browser-model-dialog-active :deep(.browser-model-step-leave-active) {
  transition: opacity 120ms ease;
}
.browser-model-dialog-active :deep(.browser-model-step-enter-from) {
  opacity: 0;
  transform: translateY(5px);
}
.browser-model-dialog-active :deep(.browser-model-step-leave-to) {
  opacity: 0;
}
@keyframes browser-model-dialog-arrive {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.975);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes browser-model-dialog-depart {
  to {
    opacity: 0;
    transform: translateY(8px) scale(0.99);
  }
}
@keyframes browser-model-dialog-veil {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes browser-model-files-hint-appear {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes browser-model-benefit-appear {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@media (max-width: 639px) {
  .browser-model-dialog-active {
    padding: 0;
  }
  .browser-model-dialog-active .browser-model-dialog-panel {
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 0;
  }
  .browser-model-dialog-close {
    top: max(0.75rem, env(safe-area-inset-top));
  }
  .browser-model-dialog-active :deep(.onboarding-language) {
    top: max(0.875rem, env(safe-area-inset-top));
  }
  .browser-model-dialog-active :deep(.browser-model-welcome) {
    padding-bottom: max(1.5rem, env(safe-area-inset-bottom));
  }
}
@media (max-height: 700px) {
  .browser-model-dialog-active {
    padding-block: 12px;
  }
  .browser-model-dialog-active :deep(.browser-model-welcome) {
    padding-top: 3.5rem;
  }
}
@media (max-width: 639px) and (max-height: 700px) {
  .browser-model-dialog-active {
    padding-block: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .browser-model-dialog-active .browser-model-dialog-panel,
  .browser-model-dialog-active .browser-model-dialog-backdrop {
    animation: none;
    transition: none;
  }
  .browser-model-dialog-active :deep(.browser-model-step-enter-active),
  .browser-model-dialog-active :deep(.browser-model-step-leave-active) {
    transition: none;
  }
  .browser-model-dialog-active :deep(.onboarding-local-files),
  .browser-model-dialog-active :deep(.onboarding-benefit) {
    animation: none;
  }
}
</style>
