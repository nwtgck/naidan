<script setup lang="ts">
import { onScopeDispose, ref, watch } from 'vue';
import { useModelLaunchCoordinator } from '@/features/llama-cpp-browser/composables/useModelLaunchCoordinator';
import { useDocumentMetadata } from '@/composables/useDocumentMetadata';
import { useRoute, useRouter } from 'vue-router';
import { onKeyStroke } from '@vueuse/core';
import { useCurrentChatState } from '@/composables/chat/ui/useCurrentChatState';
import { useChatLifecycle } from '@/composables/chat/ui/useChatLifecycle';
import { useChatOrganization } from '@/composables/chat/ui/useChatOrganization';
import {
  isAppInteractionEnabled,
  useAppPresentation,
} from '@/composables/useAppPresentation';
import { useGlobalSearch } from '@/features/global-search/composables/useGlobalSearch';
import { useLayout } from '@/composables/useLayout';
import { useRecentChats } from '@/composables/useRecentChats';
import { useSettings } from '@/composables/useSettings';
import { useAppEntry, type ModelLaunchAppContext } from '@/composables/useAppEntry';
import { useToast } from '@/composables/useToast';
import { ensureStrings } from '@/strings';
import { hasModelEntryQuery } from '@/logic/startup/entry-intent';
import { creatingChat } from '@/composables/chat/global/chat-core-singletons';
import type { Chat, SystemPrompt } from '@/01-models/types';
import { idToRaw, toChatId, type ChatGroupId } from '@/01-models/ids';

const currentChatState = useCurrentChatState();
const chatLifecycle = useChatLifecycle();
const chatOrganization = useChatOrganization();
const settingsStore = useSettings();
const { appInteraction } = useAppPresentation();
const { addRecentChat, toggleRecent } = useRecentChats();
const router = useRouter();
const documentMetadata = useDocumentMetadata();
const route = useRoute();
const appEntry = useAppEntry();
const { addToast } = useToast();
const commandInFlight = ref(false);
let automaticAttemptOwner: symbol | undefined;
let commandsActive = true;
onScopeDispose(() => {
  commandsActive = false;
});
useModelLaunchCoordinator();

watch(
  [() => route.path, () => appEntry.intent.value, () => appInteraction.value],
  () => {
    if (!isAppInteractionEnabled({ interaction: appInteraction.value }) || appEntry.intent.value.kind !== 'ordinary') {
      return;
    }
    if (route.name === '/chat/[id]' && route.params.id && typeof route.params.id === 'string') {
      addRecentChat({ id: toChatId({ raw: route.params.id }) });
    }
  },
  { immediate: true },
);

type ChatCommand = {
  creation: 'always' | 'when-empty',
  context: ModelLaunchAppContext,
  routePath: string,
  fullPath: string,
  initialChatId: Chat['id'] | undefined,
  chatGroup: { kind: 'unresolved', input: string | undefined } | { kind: 'resolved', id: ChatGroupId | undefined },
  modelId: string | undefined,
  systemPrompt: SystemPrompt | undefined,
  q: string | undefined,
  chat: Chat | undefined,
};
let latestCommand: ChatCommand | undefined;

function isCommandCurrent({ command }: { command: ChatCommand }): boolean {
  return commandsActive && appEntry.interaction.value === 'ready'
    && isAppInteractionEnabled({ interaction: appInteraction.value })
    && command.context.isCurrent()
    && router.currentRoute.value.path === command.routePath
    && router.currentRoute.value.fullPath === command.fullPath
    && (command.creation !== 'when-empty' || appEntry.discovery.value === undefined);
}

function ownsCurrentChat({ command }: { command: ChatCommand }): boolean {
  // An automatic chat is saved without selecting it. The route owns selection
  // after navigation; a slow save must not replace a newer user selection.
  const creation = command.creation;
  switch (creation) {
  case 'when-empty': return currentChatState.currentChat.value?.id === command.initialChatId;
  case 'always': return currentChatState.currentChat.value?.id === (command.chat?.id ?? command.initialChatId);
  default: {
    const exhaustive: never = creation;
    throw new Error(`Unhandled chat creation selection: ${String(exhaustive)}`);
  }
  }
}

async function runChatCommand({ command }: { command: ChatCommand }): Promise<void> {
  if (command !== latestCommand || commandInFlight.value || !isCommandCurrent({ command }) || !ownsCurrentChat({ command })) {
    return;
  }
  commandInFlight.value = true;
  try {
    if (command.chat === undefined) {
      const chatGroup = command.chatGroup;
      switch (chatGroup.kind) {
      case 'unresolved': {
        const input = chatGroup.input;
        const existing = input === undefined ? undefined : currentChatState.chatGroups.value.find(candidate =>
          idToRaw({ id: candidate.id }) === input || candidate.name === input,
        );
        const chatGroupId = existing?.id ?? (input === undefined ? undefined : await chatOrganization.createChatGroup({ name: input, options: undefined }));
        command.chatGroup = { kind: 'resolved', id: chatGroupId };
        break;
      }
      case 'resolved':
        command.chatGroup = chatGroup;
        break;
      default: {
        const _ex: never = chatGroup;
        throw new Error(`Unhandled chat group resolution: ${String(_ex)}`);
      }
      }
      if (!isCommandCurrent({ command }) || !ownsCurrentChat({ command })) {
        return;
      }
      useLayout().setActiveFocusArea({ area: 'chat' });
      let chat: Chat | null | undefined;
      const creation = command.creation;
      switch (creation) {
      case 'when-empty':
        chat = await chatLifecycle.createChatForEmptyHistory({ isCurrent: () => isCommandCurrent({ command }) && ownsCurrentChat({ command }) });
        break;
      case 'always':
        chat = await chatLifecycle.createNewChat({ groupId: command.chatGroup.id, modelId: command.modelId, systemPrompt: command.systemPrompt });
        break;
      default: {
        const exhaustive: never = creation;
        throw new Error(`Unhandled chat creation command: ${String(exhaustive)}`);
      }
      }
      if (chat === undefined) {
        // A busy creator or a fresh sidebar can invalidate an empty snapshot.
        // Genuine failures keep the attempt consumed and use explicit retry.
        if (automaticAttemptOwner === command.context.owner) {
          automaticAttemptOwner = undefined;
        }
        return;
      }
      if (chat === null) {
        throw new Error('Chat creation did not return a chat.');
      }
      command.chat = chat;
    }
    if (!isCommandCurrent({ command }) || !ownsCurrentChat({ command })) {
      return;
    }
    const path = `/chat/${idToRaw({ id: command.chat.id })}`;
    const failure = await router.push(command.q === undefined ? path : { path, query: { q: command.q } });
    if (failure) {
      throw new Error('Chat navigation did not complete.');
    }
  } catch (error) {
    console.error('[AppCommandRuntime] Could not create or open chat:', error);
    if (!isCommandCurrent({ command }) || !ownsCurrentChat({ command })) {
      return;
    }
    const message = await ensureStrings.AppCommandRuntime__could_not_create_chat();
    const actionLabel = await ensureStrings.AppCommandRuntime__retry();
    if (isCommandCurrent({ command }) && ownsCurrentChat({ command })) {
      addToast({ message, actionLabel, onAction: () => runChatCommand({ command }) });
    }
  } finally {
    commandInFlight.value = false;
  }
}

watch(
  [
    () => router.currentRoute.value.fullPath,
    () => settingsStore.initialized.value,
    () => appEntry.intent.value,
    () => appEntry.interaction.value,
    () => appInteraction.value,
    () => commandInFlight.value,
    () => currentChatState.sidebarItems.value.length,
    () => creatingChat.value,
    () => appEntry.discovery.value,
  ],
  () => {
    const currentRoute = router.currentRoute.value;
    const mode = appEntry.intent.value.kind;
    if ((mode !== 'ordinary' && mode !== 'home') || !settingsStore.initialized.value
      || currentRoute.path !== '/' || hasModelEntryQuery({ query: currentRoute.query }) || commandInFlight.value) {
      return;
    }
    const q = currentRoute.query.q;
    if (q && mode !== 'ordinary') {
      return;
    }
    const automatic = !q && mode === 'home';
    if (!q && (!automatic || currentChatState.sidebarItems.value.length !== 0
      || creatingChat.value || appEntry.discovery.value !== undefined)) {
      return;
    }
    const context = appEntry.captureModelLaunchContext();
    if (automaticAttemptOwner === context.owner) {
      return;
    }
    const systemPromptStr = currentRoute.query['system-prompt'] || currentRoute.query.sp;
    const command: ChatCommand = {
      creation: automatic ? 'when-empty' : 'always',
      context,
      routePath: currentRoute.path,
      fullPath: currentRoute.fullPath,
      initialChatId: currentChatState.currentChat.value?.id,
      chatGroup: { kind: 'unresolved', input: q && typeof currentRoute.query['chat-group'] === 'string' ? currentRoute.query['chat-group'] : undefined },
      modelId: q && typeof currentRoute.query.model === 'string' ? currentRoute.query.model : undefined,
      systemPrompt: q && typeof systemPromptStr === 'string' && systemPromptStr ? { behavior: 'override', content: systemPromptStr } : undefined,
      q: q ? q.toString() : undefined,
      chat: undefined,
    };
    if (!isCommandCurrent({ command })) {
      return;
    }
    // A visit gets one automatic attempt. Only its explicit retry may resume it.
    automaticAttemptOwner = context.owner;
    latestCommand = command;
    void runChatCommand({ command });
  },
  { immediate: true },
);

onKeyStroke(['o', 'O', 'k', 'K', 'p', 'P'], async (event) => {
  if (!isAppInteractionEnabled({ interaction: appInteraction.value })) {
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'o' || event.key === 'O')) {
    event.preventDefault();
    if (commandInFlight.value || appEntry.interaction.value !== 'ready') {
      return;
    }
    documentMetadata?.finishHomeIntroduction();
    const context = appEntry.captureModelLaunchContext();
    automaticAttemptOwner = context.owner;
    const command: ChatCommand = {
      creation: 'always',
      context,
      routePath: router.currentRoute.value.path,
      fullPath: router.currentRoute.value.fullPath,
      initialChatId: currentChatState.currentChat.value?.id,
      chatGroup: { kind: 'resolved', id: undefined },
      modelId: undefined,
      systemPrompt: undefined,
      q: undefined,
      chat: undefined,
    };
    latestCommand = command;
    await runChatCommand({ command });
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'k' || event.key === 'K')) {
    const isMac = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform);
    if (isMac && !event.metaKey) {
      return;
    }
    event.preventDefault();
    useGlobalSearch().toggleSearch();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'p' || event.key === 'P')) {
    event.preventDefault();
    toggleRecent();
  }
});


defineExpose({
  ...((__BUILD_MODE_IS_TEST__ && {
    TEST_ONLY: {
      // Export internal state and logic used only for testing here. Do not reference these in production logic.
    },
  }) || {}),
});
</script>

<template>
  <span tw-class="hidden" aria-hidden="true" />
</template>
