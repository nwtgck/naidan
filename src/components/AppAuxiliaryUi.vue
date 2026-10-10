<script setup lang="ts">
import { type Component, computed, defineAsyncComponent, nextTick, ref, shallowRef, watch } from 'vue';
import { useModelPresetCoordinator } from '@/features/llama-cpp-browser/model-preset';
import { resolveInitialRoute } from '@/logic/startup/startup-route';
import { START_LOCATION, useRoute, useRouter } from 'vue-router';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import { useLayout } from '@/composables/useLayout';
import { usePrint } from '@/composables/usePrint';
import { useRecentChats } from '@/composables/useRecentChats';
import { isModelSupportInvestigationAvailable, loadModelSupportInvestigationModal } from '@/features/transformers-js/model-support-investigation';
import { transformersJsService } from '@/features/transformers-js';
import { downloadTimingSnapshotSchema, parseDownloadTiming, type DownloadTimingSnapshot } from '@/features/transformers-js/download-timing';

const PrintView = defineAsyncComponent(() => import('@/components/PrintView.vue'));
const ChatPrintContent = defineAsyncComponent(() => import('@/components/ChatPrintContent.vue'));
const LlamaCppBrowserPerformanceModal = shallowRef<Component>();
const SettingsModal = defineAsyncComponent(() => import('@/components/SettingsModal.vue'));
const DebugWeshTerminalModal = defineAsyncComponent(() => import('@/features/wesh-terminal/components/DebugWeshTerminalModal.vue'));
const GlobalSearchModal = defineAsyncComponent(() => import('@/features/global-search/components/GlobalSearchModal.vue'));
const RecentChatsModal = defineAsyncComponent(() => import('@/components/RecentChatsModal.vue'));
const FileExplorerModal = defineAsyncComponent(() => import('@/features/file-explorer/components/FileExplorerModal.vue'));
const ModelSupportInvestigationModal = isModelSupportInvestigationAvailable
  ? defineAsyncComponent(loadModelSupportInvestigationModal)
  : undefined;
const PWAManager = __BUILD_MODE_IS_HOSTED__
  ? defineAsyncComponent(() => import('@/components/PWAManager.vue'))
  : undefined;

const router = useRouter();
const route = useRoute();
const { isWeshTerminalOpen, toggleWeshTerminal } = useLayout();
const { isFileExplorerOpen } = useFileExplorerModal();
const { isSearchOpen } = useGlobalSearch();
const { isRecentOpen } = useRecentChats();
const { activePrintMode } = usePrint();
const modelPreset = useModelPresetCoordinator();
watch(() => modelPreset?.value, preset => {
  const target = preset?.target;
  switch (target) {
  case undefined: case 'onboarding': return;
  case 'settings': break;
  default: { const exhaustive: never = target; throw new Error(String(exhaustive)); }
  }
  const destination = router.currentRoute.value === START_LOCATION ? resolveInitialRoute({ router }) : route;
  void router.replace({ path: destination.path, query: { ...destination.query, settings: 'llama-cpp-browser' }, hash: destination.hash });
}, { immediate: true });
const isSettingsOpen = computed(() => route.path.startsWith('/settings') || !!route.query.settings);
const modelSupportInvestigationModelId = ref<string | undefined>(undefined);
const llamaPerformanceOpened = ref(false);
const llamaPerformanceVisible = ref(false);
const llamaPerformanceDefaultModel = ref<string>();
const llamaPerformanceLoading = ref(false);
const llamaPerformanceLoadError = ref('');
let llamaPerformanceLoadEpoch = 0;
let llamaPerformanceOpener: HTMLElement | undefined;

async function openLlamaCppPerformance({ defaultModel }: { defaultModel: string | undefined }): Promise<void> {
  if (llamaPerformanceLoading.value) return;
  const epoch = ++llamaPerformanceLoadEpoch;
  llamaPerformanceLoading.value = true; llamaPerformanceLoadError.value = '';
  llamaPerformanceOpener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
  try {
    // Keep Settings visible until the lazy chunk is ready; a failed import must
    // not replace the only usable screen with an empty overlay.
    LlamaCppBrowserPerformanceModal.value ??= (await import('@/features/llama-cpp-browser/components/LlamaCppBrowserPerformanceModal.vue')).default;
    if (epoch !== llamaPerformanceLoadEpoch || !isSettingsOpen.value) return;
    llamaPerformanceDefaultModel.value = defaultModel;
    llamaPerformanceOpened.value = true; llamaPerformanceVisible.value = true;
  } catch (error) {
    if (epoch === llamaPerformanceLoadEpoch) llamaPerformanceLoadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (epoch === llamaPerformanceLoadEpoch) llamaPerformanceLoading.value = false;
  }
}

function closeLlamaCppPerformance(): void {
  llamaPerformanceVisible.value = false;
  const opener = llamaPerformanceOpener; llamaPerformanceOpener = undefined;
  void nextTick(() => opener?.focus());
}

watch(isSettingsOpen, open => {
  if (!open) {
    llamaPerformanceVisible.value = false; llamaPerformanceLoadEpoch++; llamaPerformanceLoading.value = false;
  }
});
const ordinaryDownloadTiming = shallowRef<DownloadTimingSnapshot | undefined>(undefined);
let modelSupportInvestigationOpener: HTMLElement | undefined;
const lastNonSettingsLocation = ref(route.path.startsWith('/settings')
  ? '/'
  : route.fullPath);

watch(() => route.fullPath, (fullPath) => {
  if (!route.path.startsWith('/settings')) {
    lastNonSettingsLocation.value = fullPath;
  }
});

function openModelSupportInvestigation({ modelId }: { modelId: string }): void {
  if (ModelSupportInvestigationModal === undefined) return;
  modelSupportInvestigationOpener = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : undefined;
  modelSupportInvestigationModelId.value = modelId;
  // Explicitly capture the ordinary service, not MSI's independent service.
  ordinaryDownloadTiming.value = undefined;
  try {
    ordinaryDownloadTiming.value = parseDownloadTiming({ schema: downloadTimingSnapshotSchema, value: transformersJsService.getDownloadTimingSnapshot() });
  } catch {
    // Optional observations must not prevent opening an investigation.
  }
}

function closeModelSupportInvestigation(): void {
  modelSupportInvestigationModelId.value = undefined;
  ordinaryDownloadTiming.value = undefined;
  const opener = modelSupportInvestigationOpener;
  modelSupportInvestigationOpener = undefined;
  void nextTick(() => opener?.focus());
}

function closeSettings(): void {
  if (route.query.settings) {
    const query = { ...route.query };
    delete query.settings;
    void router.push({ path: route.path, query });
    return;
  }

  void router.push(lastNonSettingsLocation.value);
}


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
      closeSettings,
      openLlamaCppPerformance,
      closeLlamaCppPerformance,
      openModelSupportInvestigation,
      closeModelSupportInvestigation,
    },
  }) || {}),
});
</script>

<template>
  <div
    v-if="isSettingsOpen"
    v-show="modelSupportInvestigationModelId === undefined && !llamaPerformanceVisible"
    data-testid="settings-modal-host"
  >
    <SettingsModal
      :is-open="true"
      :suspended="llamaPerformanceVisible"
      :performance-loading="llamaPerformanceLoading"
      :performance-error="llamaPerformanceLoadError"
      @open-llama-cpp-performance="openLlamaCppPerformance({ defaultModel: $event })"
      @close="closeSettings"
      @open-model-support-investigation="openModelSupportInvestigation({ modelId: $event })"
    />
  </div>

  <LlamaCppBrowserPerformanceModal
    v-if="llamaPerformanceOpened"
    :is-open="llamaPerformanceVisible && isSettingsOpen"
    :default-model="llamaPerformanceDefaultModel"
    @close="closeLlamaCppPerformance"
  />

  <ModelSupportInvestigationModal
    v-if="ModelSupportInvestigationModal !== undefined && modelSupportInvestigationModelId !== undefined"
    :model-id="modelSupportInvestigationModelId"
    :ordinary-download-timing="ordinaryDownloadTiming"
    @close="closeModelSupportInvestigation"
  />

  <DebugWeshTerminalModal
    v-if="isWeshTerminalOpen"
    :is-open="true"
    @close="toggleWeshTerminal"
  />

  <GlobalSearchModal v-if="isSearchOpen" />
  <RecentChatsModal v-if="isRecentOpen" />
  <PWAManager v-if="PWAManager" />
  <FileExplorerModal v-if="isFileExplorerOpen" />

  <PrintView v-if="activePrintMode !== undefined">
    <ChatPrintContent v-if="activePrintMode === 'chat'" />
  </PrintView>
</template>
