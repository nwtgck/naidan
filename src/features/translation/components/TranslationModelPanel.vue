<script setup lang="ts">
import { defineAsyncComponent, nextTick, onScopeDispose, ref, useId, watch } from 'vue';
import { XIcon } from 'lucide-vue-next';
import { lazyStrings } from '@/strings';
import SettingsSelectScope from '@/components/SettingsSelectScope.vue';
const TranslationModels = defineAsyncComponent(() => import('./TranslationModels.vue'));
const props = defineProps<{ open: boolean, drawer: boolean, disabled: boolean, modelId: string | undefined, returnFocus: HTMLElement | undefined }>();
const emit = defineEmits<{ select: [modelId: string], changed: [], close: [] }>();
const id = useId();
const panel = ref<HTMLElement>();
const visited = ref(props.open);
let previousFocus: HTMLElement | undefined;
let disposed = false;

function restoreFocus(): void {
  const target = previousFocus?.isConnected ? previousFocus : props.returnFocus;
  target?.focus();
  previousFocus = undefined;
}

watch(() => props.open, async open => {
  if (open) {
    visited.value = true;
  }
  if (!open) {
    await nextTick();
    if (!disposed) {
      restoreFocus();
    }
  }
});
watch(() => props.drawer, async drawer => {
  if (drawer) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    await nextTick();
    if (!disposed && props.drawer) {
      panel.value?.focus();
    }
  } else {
    // The editor and trigger stop being inert in the same render. Restore
    // focus only after that render has committed.
    await nextTick();
    if (!disposed && !props.drawer) {
      restoreFocus();
    }
  }
}, { immediate: true });

function keydown({ event }: { event: KeyboardEvent }): void {
  if (!props.drawer || event.defaultPrevented) {
    return;
  }
  if (event.key === 'Escape') {
    event.stopPropagation();
    emit('close');
  } else if (event.key === 'Tab') {
    const elements = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? []).filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
    const first = elements[0], last = elements.at(-1);
    if (!first || !last) {
      event.preventDefault();
    } else if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.value)) {
      event.preventDefault();
      first.focus();
    }
  }
}

onScopeDispose(() => {
  disposed = true;
  if (props.drawer) {
    restoreFocus();
  }
});
defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>
<template>
  <div class="translation-catalog-disclosure" :class="{ 'translation-catalog-open': open && !drawer }" data-testid="translation-catalog-disclosure">
    <div tw-class="min-h-0 overflow-hidden">
      <!-- A single manager survives the inline -> drawer transition. Download
           state and the editor draft are not owned by a separate model page. -->
      <Teleport to="body" :disabled="!drawer">
        <div :inert="open ? undefined : true" :aria-hidden="!open" :tw-class="[drawer ? 'fixed inset-0 z-[100] flex justify-end bg-black/50 backdrop-blur-[2px]' : 'relative']" @click.self="drawer && emit('close')">
          <section ref="panel" :role="drawer ? 'dialog' : undefined" :aria-modal="drawer ? true : undefined" :aria-labelledby="`${id}-title`" :tabindex="drawer ? -1 : undefined" :class="{ 'translation-model-drawer': drawer }" :tw-class="[drawer ? 'flex h-dvh w-full max-w-2xl flex-col border-l border-gray-200 bg-white shadow-2xl outline-none dark:border-gray-800 dark:bg-gray-900' : 'space-y-3']" data-testid="translation-model-panel" @keydown="keydown({ event: $event })">
            <header :tw-class="['flex shrink-0 items-center justify-between gap-3', drawer ? 'border-b border-gray-100 px-5 py-4 dark:border-gray-800' : 'px-1']"><h2 :id="`${id}-title`" tw-class="text-sm font-semibold text-gray-700 dark:text-gray-200">{{ lazyStrings.translation__translation_models() }}</h2><button v-if="drawer" type="button" data-testid="translation-close-models" :aria-label="lazyStrings.translation__back_to_translation()" @click="emit('close')" tw-class="rounded-lg p-2 text-gray-400 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 dark:hover:bg-gray-800"><XIcon aria-hidden="true" tw-class="h-4 w-4" /></button></header>
            <div :tw-class="['space-y-3', drawer ? 'px-5 pt-3' : '']"><slot /></div>
            <div class="translation-model-content" :class="{ 'translation-inline-catalog': !drawer }" :tw-class="['min-h-0', drawer ? 'flex-1 p-5' : '']">
              <SettingsSelectScope :active="open" :return-focus="returnFocus"><TranslationModels v-if="visited" :suspended="!open" :disabled="disabled" :model-id="modelId" @select="emit('select', $event)" @changed="emit('changed')" /></SettingsSelectScope>
            </div>
          </section>
        </div>
      </Teleport>
    </div>
  </div>
</template>
<style scoped>
.translation-catalog-disclosure {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 220ms ease;
}
.translation-catalog-open {
  grid-template-rows: 1fr;
}
.translation-inline-catalog {
  height: clamp(20rem, 50dvh, 30rem);
}
.translation-model-drawer {
  animation: translation-drawer-enter 180ms ease-out;
}
@keyframes translation-drawer-enter {
  from {
    transform: translateX(1.5rem);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .translation-catalog-disclosure {
    transition: none;
  }
  .translation-model-drawer {
    animation: none;
  }
}
</style>
