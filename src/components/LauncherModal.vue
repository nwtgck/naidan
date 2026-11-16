<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowLeftIcon, ChevronRightIcon, FlaskConicalIcon, SearchIcon, XIcon } from 'lucide-vue-next';
import { useLauncher } from '@/composables/useLauncher';
import { useOverlay } from '@/composables/useOverlay';
import { lazyStrings } from '@/strings';
import LauncherEntryList from './LauncherEntryList.vue';
import DeveloperToolsPanel from './DeveloperToolsPanel.vue';

const emit = defineEmits<{ openModelSupportInvestigation: [] }>();
const { isLauncherOpen, view, opener, closeLauncher } = useLauncher();
const { activeOverlay } = useOverlay();
const route = useRoute();
let openedPath = route.fullPath;
let returnFocus = opener.value;
const headingId = useId();
const panel = ref<HTMLElement>();
const search = ref<HTMLInputElement>();
const back = ref<HTMLButtonElement>();
const query = ref('');
let navigating = false;

function focusView(): void {
  if (!isLauncherOpen.value) {
    return;
  }
  const current = view.value;
  switch (current) {
  case 'entries': search.value?.focus();
    return;
  case 'developer': back.value?.focus();
    return;
  default: {
    const exhaustive: never = current;
    throw new Error(String(exhaustive));
  }
  }
}

function restoreFocus(): void {
  if (!navigating && activeOverlay.value === 'none' && route.fullPath === openedPath && returnFocus?.isConnected) {
    returnFocus.focus({ preventScroll: true });
  }
}

watch(isLauncherOpen, open => {
  if (open) {
    openedPath = route.fullPath;
    returnFocus = opener.value;
    navigating = false;
    query.value = '';
    void nextTick(focusView);
  } else {
    void nextTick(restoreFocus);
  }
}, { immediate: true });
watch(view, () => {
  void nextTick(focusView);
});
onBeforeUnmount(restoreFocus);

function keydown({ event }: { event: KeyboardEvent }): void {
  if (event.isComposing || event.defaultPrevented) {
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closeLauncher();
  } else if (event.key === 'Tab') {
    const elements = Array.from(panel.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)') ?? [])
      .filter(element => !element.closest('[hidden], [inert]'));
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
}

function navigate({ restoreFocus }: { restoreFocus: boolean }): void {
  navigating = !restoreFocus;
  closeLauncher();
}

function openModelSupportInvestigation(): void {
  navigate({ restoreFocus: false });
  emit('openModelSupportInvestigation');
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <Teleport to="body">
    <Transition name="launcher" appear>
      <div v-if="isLauncherOpen" data-testid="launcher-modal" tw-class="fixed inset-0 z-[190] flex items-end justify-center bg-black/25 pt-6 backdrop-blur-[3px] dark:bg-black/50 sm:items-center sm:p-7" @click.self="closeLauncher" @keydown="keydown({ event: $event })">
        <section ref="panel" class="launcher-panel" role="dialog" aria-modal="true" :aria-labelledby="view === 'developer' ? headingId : undefined" :aria-label="view === 'entries' ? lazyStrings.launcher__more_features() : undefined" tabindex="-1" tw-class="relative flex h-[85dvh] max-h-[780px] w-full max-w-[820px] min-h-0 flex-col overflow-hidden rounded-t-3xl border border-gray-200 bg-[#fcfcfd] shadow-2xl outline-none dark:border-gray-700/70 dark:bg-gray-900 sm:h-[min(706px,calc(100dvh-52px))] sm:rounded-[22px]">
          <header v-if="view === 'developer'" tw-class="flex min-h-[61px] shrink-0 items-center gap-3 px-5 sm:min-h-[68px] sm:px-7">
            <button ref="back" type="button" data-testid="launcher-back" :aria-label="lazyStrings.launcher__back()" @click="view = 'entries'" tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-gray-500 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4" /></button>
            <h2 :id="headingId" tw-class="min-w-0 flex-1 text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-100 sm:text-[23px]">{{ lazyStrings.launcher__developer_tools() }}</h2>
            <button type="button" data-testid="launcher-close" :aria-label="lazyStrings.launcher__close()" @click="closeLauncher" tw-class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"><XIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
          </header>
          <Transition name="launcher-view" mode="out-in" @after-enter="focusView">
            <div v-if="view === 'entries'" key="entries" tw-class="flex min-h-0 flex-1 flex-col">
              <div tw-class="flex shrink-0 items-center gap-2.5 px-5 pt-5 sm:gap-3 sm:px-7 sm:pt-6">
                <label tw-class="flex min-h-[45px] min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2 text-gray-400 focus-within:border-blue-400 dark:border-gray-700/70 dark:bg-[#1c2636]">
                  <SearchIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" />
                  <input ref="search" v-model="query" type="search" autocomplete="off" :placeholder="lazyStrings.launcher__find_a_feature()" :aria-label="lazyStrings.launcher__find_a_feature()" data-testid="launcher-search" tw-class="min-w-0 flex-1 bg-transparent text-[13px] text-gray-800 outline-none placeholder:text-gray-400 dark:text-gray-100 dark:placeholder:text-gray-500" />
                </label>
                <button type="button" data-testid="launcher-close" :aria-label="lazyStrings.launcher__close()" @click="closeLauncher" tw-class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-blue-500 motion-reduce:transition-none dark:text-gray-500 dark:hover:bg-gray-800 dark:hover:text-gray-200"><XIcon aria-hidden="true" tw-class="h-5 w-5" /></button>
              </div>
              <LauncherEntryList :query="query" :blocked="false" @navigate="navigate({ restoreFocus: true })" />
              <footer tw-class="flex shrink-0 justify-end border-t border-gray-200/70 px-5 py-2 dark:border-gray-800 sm:px-7">
                <button type="button" data-testid="launcher-developer" @click="view = 'developer'" tw-class="inline-flex min-h-9 items-center gap-2 rounded-lg px-2 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"><FlaskConicalIcon aria-hidden="true" tw-class="h-3.5 w-3.5" /><span>{{ lazyStrings.launcher__developer_tools() }}</span><ChevronRightIcon aria-hidden="true" tw-class="h-3 w-3" /></button>
              </footer>
            </div>
            <DeveloperToolsPanel v-else key="developer" tw-class="min-h-0 flex-1 overflow-y-auto px-5 pb-6 sm:px-7" @navigate="navigate({ restoreFocus: $event === 'restore' })" @open-model-support-investigation="openModelSupportInvestigation" />
          </Transition>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.launcher-enter-active,
.launcher-leave-active {
  transition: opacity 180ms ease;
}
.launcher-enter-active .launcher-panel,
.launcher-leave-active .launcher-panel {
  transition: transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.launcher-enter-from,
.launcher-leave-to {
  opacity: 0;
}
.launcher-enter-from .launcher-panel,
.launcher-leave-to .launcher-panel {
  transform: translateY(12px) scale(0.99);
}
.launcher-leave-active {
  pointer-events: none;
}
.launcher-view-enter-active,
.launcher-view-leave-active {
  transition: opacity 90ms ease, transform 90ms ease;
}
.launcher-view-enter-from,
.launcher-view-leave-to {
  opacity: 0;
  transform: translateY(3px);
}
@media (prefers-reduced-motion: reduce) {
  .launcher-enter-active,
  .launcher-leave-active,
  .launcher-enter-active .launcher-panel,
  .launcher-leave-active .launcher-panel,
  .launcher-view-enter-active,
  .launcher-view-leave-active {
    transition: none;
  }
  .launcher-enter-from .launcher-panel,
  .launcher-leave-to .launcher-panel,
  .launcher-view-enter-from,
  .launcher-view-leave-to {
    transform: none;
  }
}
</style>
