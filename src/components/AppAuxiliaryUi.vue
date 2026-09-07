<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import { useLayout } from '@/composables/useLayout';
import { usePrint } from '@/composables/usePrint';
import { useRecentChats } from '@/composables/useRecentChats';
import { isModelSupportInvestigationAvailable, loadModelSupportInvestigationModal } from '@/features/transformers-js/model-support-investigation';

const PrintView = defineAsyncComponent(() => import('@/components/PrintView.vue'));
const ChatPrintContent = defineAsyncComponent(() => import('@/components/ChatPrintContent.vue'));
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
const isSettingsOpen = computed(() => route.path.startsWith('/settings') || !!route.query.settings);
const modelSupportInvestigationModelId = ref<string | undefined>(undefined);
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
}

function closeModelSupportInvestigation(): void {
  modelSupportInvestigationModelId.value = undefined;
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
      openModelSupportInvestigation,
      closeModelSupportInvestigation,
    },
  }) || {})
});
</script>

<template>
  <div
    v-if="isSettingsOpen"
    v-show="modelSupportInvestigationModelId === undefined"
    data-testid="settings-modal-host"
  >
    <SettingsModal
      :is-open="true"
      @close="closeSettings"
      @open-model-support-investigation="openModelSupportInvestigation({ modelId: $event })"
    />
  </div>

  <ModelSupportInvestigationModal
    v-if="ModelSupportInvestigationModal !== undefined && modelSupportInvestigationModelId !== undefined"
    :model-id="modelSupportInvestigationModelId"
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
