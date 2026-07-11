<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onErrorCaptured, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useFileExplorerModal } from '@/features/file-explorer/composables/useFileExplorerModal';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import { useLayout } from '@/composables/useLayout';
import { usePrint } from '@/composables/usePrint';
import { useRecentChats } from '@/composables/useRecentChats';


type AppAuxiliaryUiMode = 'preparing' | 'active';

const props = withDefaults(defineProps<{
  mode?: AppAuxiliaryUiMode,
}>(), {
  mode: 'active',
});
const emit = defineEmits<{
  initialPresentationRendered: [],
  initialPresentationRenderFailed: [payload: { error: unknown }],
}>();

const PrintView = defineAsyncComponent(() => import('@/components/PrintView.vue'));
const ChatPrintContent = defineAsyncComponent(() => import('@/components/ChatPrintContent.vue'));
const SettingsModal = defineAsyncComponent(() => import('@/components/SettingsModal.vue'));
const DebugWeshTerminalModal = defineAsyncComponent(() => import('@/features/wesh-terminal/components/DebugWeshTerminalModal.vue'));
const GlobalSearchModal = defineAsyncComponent(() => import('@/features/global-search/components/GlobalSearchModal.vue'));
const RecentChatsModal = defineAsyncComponent(() => import('@/components/RecentChatsModal.vue'));
const FileExplorerModal = defineAsyncComponent(() => import('@/features/file-explorer/components/FileExplorerModal.vue'));
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
const renderPostStartupAuxiliaryUi = computed(() => {
  const mode = props.mode;
  switch (mode) {
  case 'preparing':
    return false;
  case 'active':
    return true;
  default: {
    const _ex: never = mode;
    return _ex;
  }
  }
});
let initialPresentationSettlement: 'pending' | 'rendered' | 'failed' = 'pending';
let initialNavigationReady = false;
let settingsContentRendered = false;

function reportInitialPresentationRendered(): void {
  switch (initialPresentationSettlement) {
  case 'pending':
    initialPresentationSettlement = 'rendered';
    emit('initialPresentationRendered');
    return;
  case 'rendered':
  case 'failed':
    return;
  default: {
    const _ex: never = initialPresentationSettlement;
    return _ex;
  }
  }
}

function scheduleInitialPresentationRenderedWhenReady(): void {
  if (!initialNavigationReady) {
    return;
  }
  if (isSettingsOpen.value && !settingsContentRendered) {
    return;
  }
  void nextTick().then(() => {
    if (
      initialNavigationReady
      && (!isSettingsOpen.value || settingsContentRendered)
    ) {
      reportInitialPresentationRendered();
    }
  });
}

function reportSettingsContentRendered(): void {
  settingsContentRendered = true;
  scheduleInitialPresentationRenderedWhenReady();
}

function reportInitialPresentationFailure({ error }: { error: unknown }): void {
  switch (initialPresentationSettlement) {
  case 'pending':
    initialPresentationSettlement = 'failed';
    emit('initialPresentationRenderFailed', { error });
    return;
  case 'rendered':
  case 'failed':
    return;
  default: {
    const _ex: never = initialPresentationSettlement;
    return _ex;
  }
  }
}

onMounted(async () => {
  try {
    /**
     * WHY: MainApp mounts before the initial navigation gate is released so
     * Sidebar can begin rendering early. During that interval Vue Router still
     * exposes START_LOCATION, which looks like a non-settings route. Waiting
     * for router readiness prevents a settings deep link from being declared
     * ready before its lazy Settings Modal and selected tab exist.
     */
    await router.isReady();
    initialNavigationReady = true;
    scheduleInitialPresentationRenderedWhenReady();
  } catch (error) {
    reportInitialPresentationFailure({ error });
  }
});
watch(isSettingsOpen, open => {
  if (open) {
    settingsContentRendered = false;
  }
  scheduleInitialPresentationRenderedWhenReady();
});
onErrorCaptured(error => {
  reportInitialPresentationFailure({ error });
  // Preserve the application's existing Vue error reporting in addition to
  // notifying encrypted startup that its lock must remain visible.
  return undefined;
});
const lastNonSettingsLocation = ref(route.path.startsWith('/settings')
  ? '/'
  : route.fullPath);

watch(() => route.fullPath, (fullPath) => {
  if (!route.path.startsWith('/settings')) {
    lastNonSettingsLocation.value = fullPath;
  }
});

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
    },
  }) || {})
});
</script>

<template>
  <SettingsModal
    v-if="isSettingsOpen"
    :is-open="true"
    @close="closeSettings"
    @initial-content-rendered="reportSettingsContentRendered"
  />

  <DebugWeshTerminalModal
    v-if="renderPostStartupAuxiliaryUi && isWeshTerminalOpen"
    :is-open="true"
    @close="toggleWeshTerminal"
  />

  <GlobalSearchModal v-if="renderPostStartupAuxiliaryUi && isSearchOpen" />
  <RecentChatsModal v-if="renderPostStartupAuxiliaryUi && isRecentOpen" />
  <PWAManager v-if="renderPostStartupAuxiliaryUi && PWAManager" />
  <FileExplorerModal v-if="renderPostStartupAuxiliaryUi && isFileExplorerOpen" />

  <PrintView v-if="renderPostStartupAuxiliaryUi && activePrintMode !== undefined">
    <ChatPrintContent v-if="activePrintMode === 'chat'" />
  </PrintView>
</template>
