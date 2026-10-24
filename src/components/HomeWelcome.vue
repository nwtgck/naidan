<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, useId } from 'vue';
import { loadRouteLocation, RouterLink, useRouter } from 'vue-router';
import { ChevronRightIcon, DownloadIcon, FolderIcon, GhostIcon, InfoIcon, ListIcon, Loader2Icon, MessageSquareIcon, ShieldCheckIcon, SquarePenIcon } from 'lucide-vue-next';
import { idToRaw, type ChatId } from '@/01-models/ids';
import { useAppEntry, type ModelLaunchAppContext } from '@/composables/useAppEntry';
import { isAppInteractionEnabled, useAppPresentation } from '@/composables/useAppPresentation';
import { useDocumentMetadata } from '@/composables/useDocumentMetadata';
import { useLayout } from '@/composables/useLayout';
import { useSettings } from '@/composables/useSettings';
import { useChatListData } from '@/composables/chat/ui/useChatListData';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { usePortableAppDownload } from '@/features/file-protocol-standalone/composables/usePortableAppDownload';
import { homeDateCategory, nextHomeDateChange, selectHomeRecentItems } from '@/logic/home-welcome';
import { currentLocale, lazyStrings } from '@/strings';
import LanguageSelector from './LanguageSelector.vue';
import SettingsCollapse from './SettingsCollapse.vue';

const entry = useAppEntry();
const { appInteraction } = useAppPresentation();
const router = useRouter();
const documentMetadata = useDocumentMetadata();
const { settings } = useSettings();
const { setActiveFocusArea } = useLayout();
const { chats } = useChatListData();
const { chatGroups } = useCurrentChatState();
const portableAppDownload = usePortableAppDownload({ version: __APP_VERSION__ });
const isHosted = __BUILD_MODE_IS_HOSTED__;
const logoGradientId = useId();
const recentChatsId = useId();
const chatGroupsId = useId();
const portableDetailsId = useId();
const portableDetails = ref<'closed' | 'open'>('closed');
const portableDetailsTrigger = ref<HTMLButtonElement>();
const creation = ref<'idle' | 'creating'>('idle');
const creationError = shallowRef<{ kind: 'create' | 'open', context: ModelLaunchAppContext }>();
let savedCreation: { id: ChatId, context: ModelLaunchAppContext } | undefined;
let active = true;
const interactionReady = computed(() => entry.interaction.value === 'ready' && isAppInteractionEnabled({ interaction: appInteraction.value }));
const blocked = computed(() => !interactionReady.value || creation.value === 'creating');
const creationErrorMessage = computed(() => {
  const error = creationError.value;
  if (error === undefined || !error.context.isCurrent()) {
    return undefined;
  }
  switch (error.kind) {
  case 'create': return lazyStrings.HomeWelcome__could_not_create_chat_try_again();
  case 'open': return lazyStrings.HomeWelcome__could_not_open_chat_try_again();
  default: {
    const exhaustive: never = error.kind;
    return exhaustive;
  }
  }
});
const recentChats = computed(() => selectHomeRecentItems({ items: chats.value }));
const recentChatGroups = computed(() => recentChats.value.length === 0 ? selectHomeRecentItems({ items: chatGroups.value }) : []);
const chatGroupNames = computed(() => new Map(recentChats.value.flatMap(chat => {
  const chatGroup = chatGroups.value.find(candidate => candidate.id === chat.groupId);
  return chatGroup === undefined ? [] : [[chatGroup.id, chatGroup.name] as const];
})));
const now = ref(Date.now());
const dateFormatter = computed(() => new Intl.DateTimeFormat(currentLocale.value, { month: 'numeric', day: 'numeric' }));
const relativeDateFormatter = computed(() => new Intl.RelativeTimeFormat(currentLocale.value, { numeric: 'auto' }));
let dateTimer: ReturnType<typeof setTimeout> | undefined;

function updatedDate({ timestamp }: { timestamp: number }): string {
  const category = homeDateCategory({ timestamp, now: now.value });
  switch (category) {
  case 'today': return relativeDateFormatter.value.format(0, 'day');
  case 'yesterday': return relativeDateFormatter.value.format(-1, 'day');
  case 'date': return dateFormatter.value.format(timestamp);
  default: {
    const exhaustive: never = category;
    return exhaustive;
  }
  }
}

function refreshDate(): void {
  clearTimeout(dateTimer);
  now.value = Date.now();
  const visibility = document.visibilityState;
  switch (visibility) {
  case 'visible':
    dateTimer = setTimeout(refreshDate, nextHomeDateChange({ now: now.value }) - now.value);
    break;
  case 'hidden':
    break;
  default: {
    const exhaustive: never = visibility;
    throw new Error(`Unhandled document visibility: ${exhaustive}`);
  }
  }
}

onMounted(() => {
  refreshDate();
  document.addEventListener('visibilitychange', refreshDate);
  window.addEventListener('focus', refreshDate);
});
onScopeDispose(() => {
  active = false;
  clearTimeout(dateTimer);
  document.removeEventListener('visibilitychange', refreshDate);
  window.removeEventListener('focus', refreshDate);
});

async function createChat(): Promise<void> {
  if (blocked.value) {
    return;
  }
  if (savedCreation !== undefined && !savedCreation.context.isCurrent()) {
    savedCreation = undefined;
  }
  const context = savedCreation?.context ?? entry.captureModelLaunchContext();
  const isCurrent = () => active && context.isCurrent() && interactionReady.value;
  creation.value = 'creating';
  creationError.value = undefined;
  try {
    if (savedCreation === undefined) {
      const { useChatLifecycle } = await import('@/composables/chat/ui/useChatLifecycle');
      if (!isCurrent()) {
        return;
      }
      // Save without replacing a newer selection while persistence is pending.
      // The destination route owns selecting the saved chat.
      const chat = await useChatLifecycle().createChatWithoutSelecting({ groupId: undefined, modelId: undefined, systemPrompt: undefined });
      if (!isCurrent()) {
        return;
      }
      if (chat === null) {
        throw new Error('Chat creation did not return a chat.');
      }
      savedCreation = { id: chat.id, context };
    }
    const chatPath = `/chat/${idToRaw({ id: savedCreation.id })}`;
    // Load the page before starting navigation so a storage change during its
    // import cannot send us to an old ID or interfere with a newer navigation.
    await loadRouteLocation(router.resolve(chatPath));
    if (!isCurrent()) {
      return;
    }
    const failure = await router.push(chatPath);
    if (failure) {
      throw new Error('Chat navigation did not complete.');
    }
    if (router.currentRoute.value.path === chatPath) {
      documentMetadata?.finishHomeIntroduction();
      setActiveFocusArea({ area: 'chat' });
    }
  } catch (error) {
    if (isCurrent()) {
      console.error('[HomeWelcome] Could not create or open chat:', error);
      creationError.value = { kind: savedCreation === undefined ? 'create' : 'open', context };
    }
  } finally {
    creation.value = 'idle';
  }
}

function chooseModel(): void {
  if (!blocked.value) {
    entry.openModelSelection({ target: { kind: 'home' }, selection: entry.homeSelection.value, opener: document.activeElement instanceof HTMLElement ? document.activeElement : undefined });
  }
}

defineExpose({ ...((__BUILD_MODE_IS_TEST__ && { TEST_ONLY: {} }) || {}) });
</script>

<template>
  <div data-testid="home-welcome" :inert="!interactionReady || undefined" :aria-busy="creation === 'creating'" tw-class="@container relative h-full min-h-0 overflow-y-auto bg-[#fcfcfd] text-gray-800 dark:bg-gray-900 dark:text-gray-100">
    <div tw-class="absolute right-4 top-4 z-10 sm:right-7 sm:top-6"><LanguageSelector /></div>

    <main class="home-content" tw-class="mx-auto w-full max-w-[44rem] px-5 sm:px-9">
      <header tw-class="text-center">
        <h1 class="home-brand">
          <span class="home-brand-mark" aria-hidden="true">
            <span class="home-brand-glow" />
            <svg viewBox="0 0 24 24" fill="none" tw-class="relative block h-full w-full">
              <defs>
                <linearGradient :id="logoGradientId" x1="24" y1="0" x2="0" y2="24" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#7dd3fc" />
                  <stop offset="45%" stop-color="#3b82f6" />
                  <stop offset="100%" stop-color="#1d4ed8" />
                </linearGradient>
              </defs>
              <path class="home-brand-frame" style="--home-frame-offset: -2px" d="M5 8V6C5 4.89543 5.89543 4 7 4H17C18.1046 4 19 4.89543 19 6V8" :stroke="`url(#${logoGradientId})`" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" pathLength="1" />
              <path class="home-brand-frame" style="--home-frame-offset: 2px" d="M5 16V18C5 19.1046 5.89543 20 7 20H17C18.1046 20 19 19.1046 19 18V16" :stroke="`url(#${logoGradientId})`" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" pathLength="1" />
              <rect class="home-brand-core" x="9" y="9" width="6" height="6" rx="2" :fill="`url(#${logoGradientId})`" />
            </svg>
          </span>
          <span class="home-brand-name" tw-class="bg-gradient-to-br from-gray-800 to-gray-500 dark:from-white dark:to-gray-400 bg-clip-text text-transparent">Naidan</span>
        </h1>
        <p class="home-arrival" style="--home-delay: 140ms" tw-class="mx-auto mt-4 flex max-w-md items-start justify-center gap-2 text-xs leading-relaxed text-gray-500 dark:text-gray-400 sm:text-[13px]">
          <GhostIcon v-if="settings.storageType === 'memory'" aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-indigo-400" />
          <ShieldCheckIcon v-else aria-hidden="true" tw-class="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500/80 dark:text-blue-400/80" />
          <span>{{ settings.storageType === 'memory' ? lazyStrings.HomeWelcome__conversations_in_memory_are_cleared_on_reload() : lazyStrings.HomeWelcome__conversations_are_stored_on_this_device() }}</span>
        </p>
      </header>

      <div class="home-arrival" style="--home-delay: 180ms" tw-class="mt-6 sm:mt-7">
        <div tw-class="flex flex-wrap items-center justify-center gap-x-2 gap-y-2 sm:gap-x-4">
          <button
            type="button"
            data-testid="home-new-chat"
            :disabled="blocked"
            :aria-busy="creation === 'creating'"
            @click="createChat"
            tw-class="group inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-gray-200/90 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition-colors duration-200 hover:border-blue-300/70 hover:bg-blue-50/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-wait disabled:opacity-60 dark:border-gray-700/80 dark:bg-gray-800/50 dark:text-gray-200 dark:hover:border-blue-400/40 dark:hover:bg-gray-800 sm:px-4 sm:text-sm"
          >
            <span tw-class="text-gray-400 transition-colors group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400">
              <Loader2Icon v-if="creation === 'creating'" aria-hidden="true" tw-class="h-4 w-4 animate-spin motion-reduce:animate-none" />
              <SquarePenIcon v-else aria-hidden="true" tw-class="h-4 w-4" />
            </span>
            <span tw-class="whitespace-nowrap">{{ lazyStrings.HomeWelcome__start_a_new_chat() }}</span>
          </button>

          <button type="button" data-testid="open-model-welcome" aria-haspopup="dialog" :disabled="blocked" @click="chooseModel" tw-class="group -mr-2 inline-flex min-h-10 items-center gap-2 rounded-lg px-2 py-2 text-xs text-gray-500 transition-colors hover:bg-gray-100/70 hover:text-gray-800 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800/60 dark:hover:text-gray-200">
            <ListIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 dark:text-gray-500" />
            <span>{{ lazyStrings.BrowserModelWelcome__choose_a_model() }}</span>
            <ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 text-gray-400 transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none dark:text-gray-500" />
          </button>
        </div>
        <p v-if="creationErrorMessage" data-testid="home-creation-error" role="alert" tw-class="mt-3 text-center text-xs leading-relaxed text-red-600 dark:text-red-400">{{ creationErrorMessage }}</p>
      </div>

      <section v-if="recentChats.length > 0" class="home-arrival" style="--home-delay: 250ms" :aria-labelledby="recentChatsId" tw-class="mx-auto mt-10 w-full max-w-xl sm:mt-12">
        <div tw-class="mb-3 flex items-center justify-between gap-4 px-1">
          <h2 :id="recentChatsId" tw-class="text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.HomeWelcome__recent_chats() }}</h2>
          <span tw-class="text-[10px] text-gray-400 dark:text-gray-500">{{ lazyStrings.HomeWelcome__most_recently_updated() }}</span>
        </div>
        <div tw-class="divide-y divide-gray-100 dark:divide-gray-800/70">
          <RouterLink
            v-for="chat in recentChats"
            :key="idToRaw({ id: chat.id })"
            :to="`/chat/${idToRaw({ id: chat.id })}`"
            :title="chat.title || lazyStrings.SHARED__new_chat()"
            data-testid="home-recent-chat"
            tw-class="group -mx-2 flex min-h-[68px] items-center gap-3.5 rounded-xl px-3 py-3 text-left transition-colors duration-200 hover:bg-gray-100/70 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800/50 sm:-mx-3 sm:gap-4 sm:px-4"
          >
            <MessageSquareIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-blue-500 dark:text-gray-500 dark:group-hover:text-blue-400" />
            <span tw-class="min-w-0 flex-1 space-y-1">
              <span tw-class="block truncate text-sm font-medium leading-relaxed text-gray-700 transition-colors group-hover:text-gray-950 dark:text-gray-300 dark:group-hover:text-gray-100">{{ chat.title || lazyStrings.SHARED__new_chat() }}</span>
              <span v-if="chat.groupId && chatGroupNames.has(chat.groupId)" tw-class="flex min-w-0 items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500"><FolderIcon aria-hidden="true" tw-class="h-3 w-3 shrink-0" /><span tw-class="truncate">{{ chatGroupNames.get(chat.groupId) }}</span></span>
            </span>
            <time :datetime="new Date(chat.updatedAt).toISOString()" tw-class="shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500">{{ updatedDate({ timestamp: chat.updatedAt }) }}</time>
            <ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-300 transition-[color,transform] group-hover:translate-x-0.5 group-hover:text-gray-500 motion-reduce:transition-none dark:text-gray-600 dark:group-hover:text-gray-400" />
          </RouterLink>
        </div>
      </section>

      <section v-else-if="recentChatGroups.length > 0" class="home-arrival" style="--home-delay: 250ms" :aria-labelledby="chatGroupsId" tw-class="mx-auto mt-10 w-full max-w-xl sm:mt-12">
        <h2 :id="chatGroupsId" tw-class="mb-3 px-1 text-xs font-medium text-gray-500 dark:text-gray-400">{{ lazyStrings.HomeWelcome__chat_groups() }}</h2>
        <div tw-class="divide-y divide-gray-100 dark:divide-gray-800/70">
          <RouterLink v-for="chatGroup in recentChatGroups" :key="idToRaw({ id: chatGroup.id })" :to="`/chat-group/${idToRaw({ id: chatGroup.id })}`" data-testid="home-chat-group" tw-class="group -mx-2 flex min-h-[68px] items-center gap-3.5 rounded-xl px-3 py-3 text-left transition-colors duration-200 hover:bg-gray-100/70 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-gray-800/50 sm:-mx-3 sm:gap-4 sm:px-4">
            <FolderIcon aria-hidden="true" tw-class="h-4 w-4 shrink-0 text-blue-500/70 dark:text-blue-400/70" />
            <span tw-class="min-w-0 flex-1 truncate text-sm font-medium text-gray-700 dark:text-gray-300">{{ chatGroup.name }}</span>
            <time :datetime="new Date(chatGroup.updatedAt).toISOString()" tw-class="shrink-0 text-[11px] tabular-nums text-gray-400 dark:text-gray-500">{{ updatedDate({ timestamp: chatGroup.updatedAt }) }}</time>
            <ChevronRightIcon aria-hidden="true" tw-class="h-3.5 w-3.5 shrink-0 text-gray-300 transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none dark:text-gray-600" />
          </RouterLink>
        </div>
      </section>

      <footer v-if="isHosted" class="home-arrival" style="--home-delay: 320ms" tw-class="mt-7 text-center sm:mt-9">
        <div tw-class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
          <a :href="portableAppDownload.href" :download="portableAppDownload.fileName" data-testid="portable-html-download" tw-class="group inline-flex min-h-8 max-w-full items-center justify-center gap-2 rounded text-[11px] text-gray-500 transition-colors hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:text-gray-400 dark:hover:text-blue-400">
            <span>{{ lazyStrings.SHARED__download_portable_html_edition() }}</span>
            <span tw-class="shrink-0 rounded border border-gray-200/80 px-1 py-0.5 text-[8px] font-medium leading-none text-gray-400 dark:border-gray-700/80 dark:text-gray-500">ZIP</span>
            <DownloadIcon aria-hidden="true" tw-class="h-3 w-3 transition-transform group-hover:translate-y-0.5 motion-reduce:transition-none" />
          </a>
          <button ref="portableDetailsTrigger" type="button" :aria-label="lazyStrings.HomeWelcome__how_to_open_the_portable_html_edition()" :title="lazyStrings.HomeWelcome__how_to_open_the_portable_html_edition()" data-testid="portable-html-info" :aria-expanded="portableDetails === 'open'" :aria-controls="portableDetailsId" :disabled="blocked" @click="portableDetails = portableDetails === 'open' ? 'closed' : 'open'" :tw-class="['inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-blue-50/70 hover:text-blue-600 focus-visible:outline-2 focus-visible:outline-blue-500 dark:hover:bg-blue-400/10 dark:hover:text-blue-400', portableDetails === 'open' ? 'bg-blue-50/70 text-blue-600 dark:bg-blue-400/10 dark:text-blue-400' : 'text-gray-400 dark:text-gray-500']">
            <InfoIcon aria-hidden="true" tw-class="h-3.5 w-3.5" />
          </button>
        </div>
        <SettingsCollapse :id="portableDetailsId" :open="portableDetails === 'open'" :return-focus="portableDetailsTrigger">
          <ul tw-class="mx-auto w-fit max-w-sm list-disc space-y-1 pb-1 pl-4 pt-2 text-left text-[11px] leading-relaxed text-gray-500 marker:text-blue-400/70 dark:text-gray-400">
            <li>{{ lazyStrings.HomeWelcome__extract_zip_and_open_index_html_in_your_browser() }}</li>
            <li>{{ lazyStrings.HomeWelcome__no_http_server_setup_required() }}</li>
          </ul>
        </SettingsCollapse>
      </footer>
    </main>
  </div>
</template>

<style scoped>
.home-content {
  padding-top: clamp(5.5rem, 14dvh, 10rem);
  padding-bottom: clamp(2rem, 6dvh, 5rem);
}

.home-brand {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.18em;
  margin: 0;
  font-size: clamp(2.25rem, 10cqw, 3.875rem);
  line-height: 1;
}

.home-brand-mark {
  position: relative;
  width: 1.6em;
  height: 1.6em;
  flex: none;
}

/* Typography copied from the Docs wordmark; color utilities match the sidebar.
   Keep this app-owned presentation independent of Docs components and styles. */
.home-brand-name {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-weight: 700;
  letter-spacing: -0.025em;
  line-height: 1;
  animation: home-wordmark 750ms cubic-bezier(0.22, 1, 0.36, 1) 180ms both;
}

.home-brand-glow {
  position: absolute;
  inset: -15%;
  border-radius: 50%;
  background: radial-gradient(circle, rgb(59 130 246 / 35%), transparent 68%);
  filter: blur(14px);
  opacity: 0.25;
  animation: home-brand-light 1600ms ease-out both;
}

.home-brand-frame {
  stroke-dasharray: 1;
  stroke-dashoffset: 0;
  animation: home-brand-frame 950ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.home-brand-core {
  transform-box: fill-box;
  transform-origin: center;
  animation: home-brand-core 850ms cubic-bezier(0.22, 1, 0.36, 1) 150ms both;
}

.home-arrival {
  animation: home-arrival 650ms cubic-bezier(0.22, 1, 0.36, 1) var(--home-delay) both;
}

.home-arrival:focus-within {
  animation: none;
}

@keyframes home-wordmark {
  from {
    opacity: 0;
    transform: translateX(10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes home-brand-frame {
  from {
    opacity: 0;
    stroke-dashoffset: 1;
    transform: translateY(var(--home-frame-offset));
  }
  to {
    opacity: 1;
    stroke-dashoffset: 0;
    transform: translateY(0);
  }
}

@keyframes home-brand-core {
  0% {
    opacity: 0;
    transform: scale(0.35);
  }
  65% {
    opacity: 1;
    transform: scale(1.06);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes home-brand-light {
  0% {
    opacity: 0;
    transform: scale(0.8);
  }
  45% {
    opacity: 0.65;
  }
  100% {
    opacity: 0.25;
    transform: scale(1);
  }
}

@keyframes home-arrival {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-height: 620px) {
  .home-content {
    padding-top: 4.5rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .home-arrival,
  .home-brand-name,
  .home-brand-frame,
  .home-brand-core,
  .home-brand-glow {
    animation: none;
  }
}
</style>
