<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';
import type { ChatLocalModelUi } from '@/composables/chat/chat-scoped/useChatLocalModel';
import { useChatModelRecoveryLayout } from '@/composables/chat/ui/useChatModelRecoveryLayout';
import ChatModelRecoverySummary, { type ChatModelRecoveryNotice } from './ChatModelRecoverySummary.vue';

const props = defineProps<{
  notice: ChatModelRecoveryNotice | undefined,
  state: ChatLocalModelUi,
  availability: 'available' | 'unavailable',
  presentation: 'visible' | 'suppressed',
  placement: {
    overlayRoot: HTMLElement | undefined,
    anchorHost: HTMLElement | undefined,
    anchorViewport: HTMLElement | undefined,
    anchorClip: HTMLElement | undefined,
    messageViewport: HTMLElement | undefined,
  },
}>();
const emit = defineEmits<{ recheck: [], 'model-drop-area-active': [] }>();
const ChatLocalModelInput = defineAsyncComponentAndLoadOnMounted({ loader: () => import('@/features/llama-cpp-browser/components/ChatLocalModelInput.vue') });
const id = useId();
const anchor = ref<HTMLElement>();
const summary = ref<InstanceType<typeof ChatModelRecoverySummary>>();
const expansion = defineModel<'closed' | 'open'>('expansion', { required: true });
const hasOpened = ref(false);
const visible = computed(() => props.presentation === 'visible' && (props.notice !== undefined || props.state.operation.value !== undefined || expansion.value === 'open'));
const layout = useChatModelRecoveryLayout({
  anchor: computed(() => anchor.value ?? undefined),
  anchorViewport: computed(() => props.placement.anchorViewport),
  anchorClip: computed(() => props.placement.anchorClip),
  root: computed(() => props.placement.overlayRoot),
  viewport: computed(() => props.placement.messageViewport),
  toolbar: computed(() => summary.value?.element ?? undefined),
});
const frameStyle = computed(() => {
  const value = layout.layout.value;
  return value === undefined ? undefined : {
    left: `${value.left}px`,
    bottom: `${value.bottom}px`,
    width: `${value.width}px`,
    '--recovery-compact-height': `${value.compactHeight}px`,
    '--recovery-expanded-height': `${value.expandedHeight}px`,
  };
});
watch(visible, value => {
  if (!value) {
    expansion.value = 'closed';
  }
});
watch(expansion, value => {
  switch (value) {
  case 'open': hasOpened.value = true;
    break;
  case 'closed': break;
  default: {
    const exhaustive: never = value;
    throw new Error(String(exhaustive));
  }
  }
  void nextTick(layout.measure);
});

function close({ restoreFocus }: { restoreFocus: boolean }): void {
  expansion.value = 'closed';
  if (restoreFocus) {
    void nextTick(() => {
      if (visible.value && summary.value?.trigger?.isConnected) {
        summary.value.trigger.focus({ preventScroll: true });
      }
    });
  }
}

function toggle(): void {
  const presentation = props.presentation;
  switch (presentation) {
  case 'visible': break;
  case 'suppressed': return;
  default: {
    const exhaustive: never = presentation;
    throw new Error(String(exhaustive));
  }
  }
  switch (expansion.value) {
  case 'closed': expansion.value = 'open';
    break;
  case 'open': close({ restoreFocus: true });
    break;
  default: {
    const exhaustive: never = expansion.value;
    throw new Error(String(exhaustive));
  }
  }
}

function escape({ event }: { event: KeyboardEvent }): void {
  if (event.key === 'Escape' && !event.defaultPrevented && expansion.value === 'open') {
    event.preventDefault();
    event.stopPropagation();
    close({ restoreFocus: true });
  }
}

function activateSurface({ event }: { event: MouseEvent }): void {
  if (expansion.value !== 'closed' || props.state.operation.value?.phase === 'committing'
    || !(event.target instanceof Element) || event.target.closest('button, a, input, select, textarea, summary') !== null) {
    return;
  }
  const selection = window.getSelection();
  if (selection !== null && !selection.isCollapsed && selection.anchorNode !== null
    && event.currentTarget instanceof Element && event.currentTarget.contains(selection.anchorNode)) {
    return;
  }
  // The explicit button remains the single keyboard control. Pointer users
  // may also use the entire compact surface, without stealing text selection.
  toggle();
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <Teleport v-if="placement.anchorHost !== undefined" :to="placement.anchorHost">
    <!-- Only this closed summary participates in composer measurement. Reuse
         its rendering so locale, fonts and wrapping update the reserve too. -->
    <div v-show="visible" ref="anchor" data-testid="model-recovery-footprint" aria-hidden="true" inert class="recovery-footprint" tw-class="mx-auto w-full max-w-4xl border border-transparent">
      <ChatModelRecoverySummary :notice="notice" expansion="closed" semantics="measurement" :heading-id="undefined" :panel-id="undefined" :committing="false" />
    </div>
  </Teleport>
  <Teleport v-if="placement.overlayRoot !== undefined" :to="placement.overlayRoot">
    <section
      v-show="visible && frameStyle !== undefined"
      :id="id"
      data-testid="model-recovery"
      :style="frameStyle"
      :aria-labelledby="`${id}-heading`"
      :inert="!visible || undefined"
      class="recovery-frame"
      :class="{ 'recovery-expanded': expansion === 'open', 'recovery-compact': expansion === 'closed', 'recovery-frame-scroll': expansion === 'open' && layout.scrollMode.value === 'frame' }"
      :tw-class="['absolute flex min-h-0 flex-col border bg-gray-50 text-left pointer-events-auto dark:bg-gray-900', expansion === 'open' ? 'rounded-2xl border-gray-200 shadow-xl shadow-gray-900/10 dark:border-gray-700 dark:shadow-black/25' : 'rounded-xl border-gray-200/80 shadow-sm dark:border-gray-700/70']"
      @keydown="escape({ event: $event })"
      @click="activateSurface({ event: $event })"
      @dragover.stop
    >
      <ChatModelRecoverySummary ref="summary" :notice="notice" :expansion="expansion" semantics="interactive" :heading-id="`${id}-heading`" :panel-id="`${id}-sources`" :committing="state.operation.value?.phase === 'committing'" tw-class="shrink-0" @toggle="toggle" @recheck="emit('recheck')" />
      <div :id="`${id}-sources`" :inert="expansion === 'closed' || undefined" :aria-hidden="expansion === 'closed'" class="recovery-picker" tw-class="min-h-0 flex-1 px-3 pb-3 sm:px-4">
        <ChatLocalModelInput v-if="hasOpened" :state="state" :availability="availability" :expansion="expansion" layout="embedded" :scroll-mode="layout.scrollMode.value" :source-tabs-host="summary?.sourceTabsHost" tw-class="min-h-0 flex-1" @model-drop-area-active="emit('model-drop-area-active')" />
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.recovery-footprint {
  visibility: hidden;
  pointer-events: none;
  container-type: inline-size;
}
.recovery-frame {
  container-type: inline-size;
  height: var(--recovery-compact-height);
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  transition: height 420ms cubic-bezier(0.22, 1, 0.36, 1), background-color 350ms ease, border-color 350ms ease, border-radius 350ms ease, box-shadow 350ms ease;
}
.recovery-expanded {
  height: var(--recovery-expanded-height);
  overflow: hidden;
}
.recovery-compact {
  cursor: pointer;
}
.recovery-picker {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: none;
  height: 0;
  padding-block: 0;
  overflow: hidden;
  opacity: 0;
  transition: opacity 140ms ease;
}
.recovery-expanded .recovery-picker {
  flex: 1;
  height: auto;
  padding-bottom: 12px;
  opacity: 1;
  transition: opacity 240ms ease 100ms;
}
.recovery-frame-scroll {
  overflow-y: auto;
}
.recovery-frame-scroll .recovery-picker {
  flex: none;
  overflow: visible;
}
@media (prefers-reduced-motion: reduce) {
  .recovery-frame, .recovery-picker, .recovery-expanded .recovery-picker {
    transition: none;
  }
}
</style>
