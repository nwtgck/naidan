<script setup lang="ts">
import { computed, defineAsyncComponent, defineComponent, h, ref, shallowReactive, watch, type Component } from 'vue';
import { RouterLink } from 'vue-router';
import { ArrowLeftIcon, GhostIcon, LibraryBigIcon, RotateCcwIcon, SettingsIcon } from 'lucide-vue-next';
import SidebarHeader from '@/components/SidebarHeader.vue';
import SidebarDebugControls from '@/components/SidebarDebugControls.vue';
import LauncherButton from '@/components/LauncherButton.vue';
import PWAUpdateNotification from '@/components/PWAUpdateNotification.vue';
import ChatSidebarActionsView from '@/components/ChatSidebarActionsView.vue';
import { requestAppSettings, useAppEntry } from '@/composables/useAppEntry';
import { useChatReturn } from '@/composables/useChatReturn';
import { useLayout } from '@/composables/useLayout';
import { useSettings } from '@/composables/useSettings';
import { useImageGenerationWorkspaceNavigation } from '@/features/image-generation/session/navigation';
import { useLiveConversationNavigation } from '@/features/live-conversation/navigation';
import { useTranslationNavigation } from '@/features/translation/navigation';
import { resolveSidebarTarget, type SidebarTarget } from '@/logic/sidebar-target';
import { lazyStrings } from '@/strings';

const props = defineProps<{ postStartupFeatures: 'inactive' | 'active' }>();
const emit = defineEmits<{ openModelSupportInvestigation: [opener: HTMLElement | undefined] }>();
const entry = useAppEntry();
const { isSidebarOpen, toggleSidebar } = useLayout();
const { settings } = useSettings();
const { chatReturnPath } = useChatReturn();
const { active: generationNavigation } = useImageGenerationWorkspaceNavigation();
const { active: liveNavigation } = useLiveConversationNavigation();
const { active: translationNavigation } = useTranslationNavigation();
const target = computed(() => resolveSidebarTarget({ route: entry.effectiveRoute.value, entryKind: entry.intent.value.kind }));
const chatGroupCreation = ref<'open' | 'closed'>('closed');
const contentReady = ref(false);
const modelControlsReady = ref(false);
const failures = shallowReactive<Partial<Record<SidebarTarget, { error: unknown, retry: () => void }[]>>>({});
const failure = computed(() => failures[target.value]?.[0]);
const failureDetails = computed(() => {
  const error = failure.value?.error;
  return error instanceof Error ? error.message : error === undefined ? undefined : String(error);
});
// The frame paints before the startup navigation gate opens. Starting an async
// component during that first render would evaluate the feature graph too early.
const featuresActive = computed(() => props.postStartupFeatures === 'active');

function sidebarComponent<T extends Component>({ loader, owner }: { loader: () => Promise<{ default: T }>, owner: SidebarTarget }) {
  return defineAsyncComponent<T>({
    loader,
    onError(error, retry) {
      recordFailure({ owner, error, retry });
    },
  });
}

function recordFailure({ owner, error, retry }: { owner: SidebarTarget, error: unknown, retry: () => void }): void {
  failures[owner] = [...(failures[owner] ?? []), { error, retry }];
}

const PreparingChatActions = defineComponent({
  setup() {
    return () => h(ChatSidebarActionsView, { expanded: isSidebarOpen.value, contentReady: false, interaction: 'preparing', groupContext: undefined });
  },
});
const ChatSidebar = sidebarComponent({ loader: () => import('@/components/ChatSidebar.vue'), owner: 'chat' });
const ChatSidebarActions = defineAsyncComponent({
  loader: () => import('@/components/ChatSidebarActions.vue'),
  loadingComponent: PreparingChatActions,
  delay: 0,
  onError(error, retry) {
    recordFailure({ owner: 'chat', error, retry });
  },
});
const ChatSidebarModelControls = sidebarComponent({ loader: () => import('@/components/ChatSidebarModelControls.vue'), owner: 'chat' });
const ImageSidebar = sidebarComponent({ loader: () => import('@/features/image-generation/components/ImageGenerationSidebar.vue'), owner: 'image_generation' });
const ImageSidebarActions = sidebarComponent({ loader: () => import('@/features/image-generation/components/ImageGenerationSidebarActions.vue'), owner: 'image_generation' });
const LiveSidebar = sidebarComponent({ loader: () => import('@/features/live-conversation/components/LiveConversationSidebar.vue'), owner: 'live_conversation' });
const LiveSidebarActions = sidebarComponent({ loader: () => import('@/features/live-conversation/components/LiveConversationSidebarActions.vue'), owner: 'live_conversation' });
const TranslationSidebar = sidebarComponent({ loader: () => import('@/features/translation/components/TranslationSidebar.vue'), owner: 'translation' });
const WorkflowSidebar = sidebarComponent({ loader: () => import('@/features/workflow/components/WorkflowSidebar.vue'), owner: 'workflow' });
const WorkflowSidebarActions = sidebarComponent({ loader: () => import('@/features/workflow/components/WorkflowSidebarActions.vue'), owner: 'workflow' });
const AudioSidebar = sidebarComponent({ loader: () => import('@/features/audio-generation/components/AudioGenerationSidebar.vue'), owner: 'audio_generation' });
const AudioTranscriptionSidebar = sidebarComponent({ loader: () => import('@/features/audio-transcription/components/AudioTranscriptionSidebar.vue'), owner: 'audio_transcription' });
const DeveloperSidebar = sidebarComponent({ loader: () => import('@/components/DeveloperToolsSidebar.vue'), owner: 'developer_tools' });

const label = computed(() => {
  const value = target.value;
  switch (value) {
  case 'chat': return lazyStrings.launcher__chat();
  case 'image_generation': return lazyStrings.launcher__image_generation();
  case 'live_conversation': return lazyStrings.launcher__live_conversation();
  case 'translation': return lazyStrings.launcher__translation();
  case 'workflow': return lazyStrings.launcher__workflows();
  case 'audio_generation': return lazyStrings.launcher__audio_generation();
  case 'audio_transcription': return lazyStrings.launcher__audio_transcription();
  case 'developer_tools': return lazyStrings.launcher__developer_tools();
  case 'settings': return lazyStrings.Sidebar__settings();
  case 'model_preview': return lazyStrings.AppSidebar__model_preview();
  case 'recovery': return lazyStrings.NotFoundPage__returning_to_home();
  case 'pending': return lazyStrings.AppSidebar__preparing_sidebar();
  default: {
    const exhaustive: never = value;
    return exhaustive;
  }
  }
});
const contentAvailable = computed(() => {
  if (!featuresActive.value) {
    return false;
  }
  const value = target.value;
  switch (value) {
  case 'chat': case 'workflow': case 'audio_generation': case 'audio_transcription': case 'developer_tools': return true;
  case 'image_generation': return generationNavigation.value !== undefined;
  case 'live_conversation': return liveNavigation.value !== undefined;
  case 'translation': return translationNavigation.value !== undefined;
  case 'settings': case 'model_preview': case 'recovery': case 'pending': return false;
  default: {
    const exhaustive: never = value;
    return exhaustive;
  }
  }
});
const waitingForContent = computed(() => {
  const value = target.value;
  switch (value) {
  case 'settings': case 'model_preview': case 'recovery': return false;
  case 'chat': case 'image_generation': case 'live_conversation': case 'translation': case 'workflow': case 'audio_generation': case 'audio_transcription': case 'developer_tools': case 'pending': return !contentAvailable.value || !contentReady.value;
  default: {
    const exhaustive: never = value;
    return exhaustive;
  }
  }
});

watch(target, () => {
  chatGroupCreation.value = 'closed';
  contentReady.value = false;
  modelControlsReady.value = false;
});

function retrySidebar(): void {
  const pending = failures[target.value];
  delete failures[target.value];
  for (const item of pending ?? []) {
    item.retry();
  }
}

function openSettings({ event }: { event: MouseEvent }): void {
  requestAppSettings({ tab: 'connection', opener: event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined });
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div tw-class="flex h-full min-h-0 flex-col select-none bg-white text-gray-900 transition-colors dark:bg-gray-900 dark:text-gray-100" data-testid="app-sidebar" :data-sidebar-target="target">
    <SidebarHeader :expanded="isSidebarOpen" @toggle="toggleSidebar">
      <template #status><GhostIcon v-if="settings.storageType === 'memory'" aria-hidden="true" tw-class="h-3.5 w-3.5 animate-pulse text-indigo-500/80 dark:text-indigo-400/80" :title="lazyStrings.Sidebar__ephemeral_session()" data-testid="sidebar-ghost-icon" /></template>
    </SidebarHeader>
    <PWAUpdateNotification />

    <div :tw-class="['shrink-0 space-y-2 py-2', isSidebarOpen ? 'px-4' : 'px-1']" data-testid="sidebar-primary">
      <template v-if="featuresActive">
        <ChatSidebarActions v-if="target === 'chat'" :expanded="isSidebarOpen" :content-ready="contentReady" @create-chat-group="chatGroupCreation = 'open'" />
        <ImageSidebarActions v-else-if="target === 'image_generation' && generationNavigation" :navigation="generationNavigation" :expanded="isSidebarOpen" />
        <LiveSidebarActions v-else-if="target === 'live_conversation' && liveNavigation" :navigation="liveNavigation" :expanded="isSidebarOpen" />
        <WorkflowSidebarActions v-else-if="target === 'workflow'" :expanded="isSidebarOpen" />
        <p v-else-if="isSidebarOpen && target !== 'pending'" tw-class="flex min-h-9 items-center truncate px-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{{ label }}</p>
      </template>
      <ChatSidebarActionsView v-else-if="target === 'chat'" :expanded="isSidebarOpen" :content-ready="false" interaction="preparing" :group-context="undefined" />
      <p v-else-if="isSidebarOpen && target !== 'pending'" tw-class="flex min-h-9 items-center truncate px-1 text-xs font-semibold text-gray-600 dark:text-gray-300">{{ label }}</p>
      <div v-if="target === 'pending'" aria-hidden="true" tw-class="flex min-h-9 items-center px-1"><span tw-class="h-2 w-1/2 animate-pulse rounded bg-gray-100 motion-reduce:animate-none dark:bg-gray-800/60" /></div>
    </div>
    <div :tw-class="['mb-2 shrink-0', isSidebarOpen ? 'px-4' : 'px-1']"><LauncherButton :expanded="isSidebarOpen" /></div>

    <div tw-class="relative flex min-h-0 flex-1 flex-col" :aria-label="label" :aria-busy="(waitingForContent && !failure) || undefined">
      <template v-if="contentAvailable">
        <ChatSidebar v-if="target === 'chat'" v-model:chat-group-creation="chatGroupCreation" @vue:mounted="contentReady = true" />
        <ImageSidebar v-else-if="target === 'image_generation' && generationNavigation" :navigation="generationNavigation" @vue:mounted="contentReady = true" />
        <LiveSidebar v-else-if="target === 'live_conversation' && liveNavigation" :navigation="liveNavigation" @vue:mounted="contentReady = true" />
        <TranslationSidebar v-else-if="target === 'translation' && translationNavigation" :navigation="translationNavigation" @vue:mounted="contentReady = true" />
        <WorkflowSidebar v-else-if="target === 'workflow'" @vue:mounted="contentReady = true" />
        <AudioSidebar v-else-if="target === 'audio_generation'" :expanded="isSidebarOpen" @vue:mounted="contentReady = true" />
        <AudioTranscriptionSidebar v-else-if="target === 'audio_transcription'" :expanded="isSidebarOpen" @vue:mounted="contentReady = true" />
        <DeveloperSidebar v-else-if="target === 'developer_tools'" :expanded="isSidebarOpen" @vue:mounted="contentReady = true" @open-model-support-investigation="emit('openModelSupportInvestigation', $event)" />
      </template>
      <div v-if="failure" role="alert" :tw-class="['space-y-2 py-4 text-xs text-red-600 dark:text-red-400', isSidebarOpen ? 'px-4' : 'px-1']" data-testid="sidebar-load-error">
        <template v-if="isSidebarOpen"><p>{{ lazyStrings.AppSidebar__could_not_load_sidebar() }}</p><p tw-class="select-text break-words text-[10px]">{{ failureDetails }}</p></template>
        <button type="button" @click="retrySidebar" :title="lazyStrings.AppSidebar__retry()" :aria-label="lazyStrings.AppSidebar__retry()" tw-class="flex min-h-8 items-center gap-2 rounded-lg px-2 text-xs hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-red-500 dark:hover:bg-red-500/10" data-testid="sidebar-retry"><RotateCcwIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.AppSidebar__retry() }}</span></button>
      </div>
      <div v-else-if="waitingForContent" role="status" :tw-class="['space-y-1 py-1', isSidebarOpen ? 'px-3' : 'px-1']" data-testid="sidebar-preparing">
        <span tw-class="sr-only">{{ lazyStrings.AppSidebar__preparing_sidebar() }}</span>
        <div aria-hidden="true" tw-class="space-y-1 animate-pulse motion-reduce:animate-none">
          <div v-for="row in 3" :key="row" :tw-class="['flex h-9 items-center gap-3 rounded-xl', isSidebarOpen ? 'px-2' : 'justify-center']">
            <span tw-class="h-4 w-4 shrink-0 rounded bg-gray-100 dark:bg-gray-800/60" />
            <span v-if="isSidebarOpen" :tw-class="['h-2 rounded bg-gray-100 dark:bg-gray-800/60', row === 2 ? 'w-1/2' : 'w-2/3']" />
          </div>
        </div>
      </div>
    </div>

    <div :tw-class="['shrink-0 border-t border-gray-100 bg-gray-50/30 dark:border-gray-800 dark:bg-black/20', target === 'chat' ? 'space-y-3' : 'space-y-1', isSidebarOpen ? 'p-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]' : 'px-1 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]']" data-testid="sidebar-footer">
      <RouterLink v-if="target !== 'chat' && target !== 'pending'" :to="chatReturnPath" :title="lazyStrings.AppSidebar__back_to_chats()" :aria-label="lazyStrings.AppSidebar__back_to_chats()" :tw-class="['flex items-center gap-2 rounded-xl p-2 text-xs font-medium text-gray-500 transition-colors hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:bg-gray-800', { 'justify-center': !isSidebarOpen }]" data-testid="sidebar-back"><ArrowLeftIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen">{{ lazyStrings.AppSidebar__back_to_chats() }}</span></RouterLink>
      <!-- Reserve the existing two-line model trigger while its controller loads. -->
      <div v-if="target === 'chat'" :hidden="!isSidebarOpen" tw-class="relative min-h-[62px] px-1" data-testid="sidebar-model-controls">
        <ChatSidebarModelControls v-if="featuresActive" :expanded="isSidebarOpen" @vue:mounted="modelControlsReady = true" />
        <div v-if="!modelControlsReady" aria-hidden="true" tw-class="absolute inset-0 flex animate-pulse flex-col gap-1 px-4 py-2.5 motion-reduce:animate-none" data-testid="sidebar-model-preparing">
          <div tw-class="flex h-4 items-center"><span tw-class="h-2 w-20 rounded bg-gray-100 dark:bg-gray-800/60" /></div>
          <div tw-class="flex h-5 items-center"><span tw-class="h-2 w-2/3 rounded bg-gray-100 dark:bg-gray-800/60" /></div>
        </div>
      </div>
      <div :tw-class="['flex items-center gap-1', { 'flex-col items-center': !isSidebarOpen }]" data-testid="sidebar-footer-actions">
        <button type="button" @click="openSettings({ event: $event })" :title="lazyStrings.Sidebar__settings()" :aria-label="lazyStrings.Sidebar__settings()" :tw-class="['flex min-w-0 items-center justify-center gap-1.5 rounded-xl border border-transparent text-xs font-bold text-gray-500 dark:text-gray-400 hover:border-gray-200 dark:hover:border-gray-700 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 transition-colors motion-reduce:transition-none', isSidebarOpen ? 'flex-1 px-2 py-2' : 'h-8 w-8']" data-testid="sidebar-settings-button"><SettingsIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /><span v-if="isSidebarOpen" tw-class="truncate">{{ lazyStrings.Sidebar__settings() }}</span></button>
        <button v-if="target === 'chat'" type="button" data-testid="sidebar-model-catalog-button" :aria-label="lazyStrings.Sidebar__find_models()" :title="lazyStrings.Sidebar__find_models()" tw-class="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-transparent text-gray-500 dark:text-gray-400 hover:border-gray-200 dark:hover:border-gray-700 hover:bg-white dark:hover:bg-gray-800 hover:text-blue-600 dark:hover:text-blue-400 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 transition-colors motion-reduce:transition-none" @click="entry.openDiscovery({ tab: undefined })"><LibraryBigIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0" /></button>
        <SidebarDebugControls :is-sidebar-open="isSidebarOpen" />
      </div>
    </div>
  </div>
</template>
