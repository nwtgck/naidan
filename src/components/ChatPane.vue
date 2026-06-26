<script setup lang="ts">
import { ensureStrings, lazyStrings } from '@/strings';
import { ref, watch, nextTick, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useChatPaneAutoScroll, type ChatPaneInitialOpenTarget, type ChatPaneScrollTarget } from '@/composables/useChatPaneAutoScroll';
import { useChatPaneSession } from '@/composables/chat/ui/useChatPaneSession';
import { useChatConversation } from '@/composables/chat/useChatConversation';
import { useChatBranches } from '@/composables/chat/useChatBranches';
import { useChatCompaction } from '@/composables/chat/useChatCompaction';
import { useChatGroups } from '@/composables/chat/useChatGroups';
import { useChatModels } from '@/composables/chat/useChatModels';
import { useChatTitle } from '@/composables/chat/useChatTitle';
import { useChatMetadata } from '@/composables/chat/useChatMetadata';
import { useChatPaneState } from '@/composables/chat/ui/useChatPaneState';
import { getSiblingsInChatBranch } from '@/composables/chat/chat-branch-helpers';
import {
  getChatContextCompactProgress,
  isChatGeneratingTitle,
  isChatProcessing,
} from '@/composables/chat/chat-activity-queries';
import { useChatDisplayFlow, type ChatFlowItem } from '@/composables/useChatDisplayFlow';
import { useImageGeneration } from '@/composables/useImageGeneration';
import { useSettings } from '@/composables/useSettings';
import { useLayout } from '@/composables/useLayout';
import { defineAsyncComponentAndLoadOnMounted } from '@/utils/vue';

// IMPORTANT: MessageItem is the core of the chat experience. We import it synchronously
// to ensure the chat history displays immediately and smoothly without individual components popping in.
import MessageItem from './MessageItem.vue';
import ToolCallGroupItem from './ToolCallGroupItem.vue';
import MessageThinking from './MessageThinking.vue';
import AssistantWaitingIndicator from './AssistantWaitingIndicator.vue';
import AssistantProcessSequence from './AssistantProcessSequence.vue';
import GeneratingIndicator from './GeneratingIndicator.vue';
// IMPORTANT: WelcomeScreen is the first thing users see in a new chat. We import it synchronously for an instant landing.
import WelcomeScreen from './WelcomeScreen.vue';
import ChatInput from './ChatInput.vue';
import ChatApprovalPanel from './chat-approval/ChatApprovalPanel.vue';
import ChatChoicesPanel from './chat-choices/ChatChoicesPanel.vue';
import ChatPaneHeader from './ChatPaneHeader.vue';
import ContextCompactProgressStrip from './ContextCompactProgressStrip.vue';
import ContextCompactSettingsDialog from './ContextCompactSettingsDialog.vue';
import TransformersJsLoadingIndicator from './TransformersJsLoadingIndicator.vue';
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const BinaryObjectPreviewModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./BinaryObjectPreviewModal.vue') });
// Lazily load the outline overlay, prefetch on mounted.
const ConversationOutlineOverlay = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ConversationOutlineOverlay.vue') });
import { useImagePreview } from '@/composables/useImagePreview';
import { useBinaryActions } from '@/composables/useBinaryActions';
import type { LmParameters } from '@/models/types';
import type { ChatId } from '@/models/ids';
import { idToRaw, toMessageId } from '@/models/ids';
import type { ChatGroupId, MessageId } from '@/models/ids';

// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatSettingsPanel = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ChatSettingsPanel.vue') });
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatTitleDialog = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ChatTitleDialog.vue') });
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const HistoryManipulationModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./HistoryManipulationModal.vue') });
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatDebugInspector = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ChatDebugInspector.vue') });
// Lazily load the media shelf, prefetch on mounted.
const ChatMediaShelf = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ChatMediaShelf.vue') });
// Lazily load modals and panels that are only shown on-demand, but prefetch them when idle.
const ChatWeshTerminalModal = defineAsyncComponentAndLoadOnMounted({ loader: () => import('./ChatWeshTerminalModal.vue') });
import {
  FolderInputIcon,
} from 'lucide-vue-next';
import { usePrint } from '@/composables/usePrint';
import { useGlobalSearch } from '@/composables/useGlobalSearch';
import { useFileExplorerModal } from '@/composables/useFileExplorerModal';
import { buildWorkerMountsForChat } from '@/composables/useChatWeshTerminalSessions';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import { hasChatOverrides } from '@/utils/chat-settings-resolver';
import { formatSettingsSourceLabel, type SettingsSource } from '@/utils/settings-labels';
import { scrollIntoViewSafe } from '@/utils/dom';
import { generateChatShareURL } from '@/services/import-export/chat-url-share';
import { useToast } from '@/composables/useToast';
import { storageService } from '@/services/storage';
import { createCompactInstruction, type ContextCompactProgress, type ContextCompactPromptMode } from '@/services/context-compact';
import { useApproval } from '@/composables/useApproval';
import { useChoices } from '@/composables/useChoices';
import { FAKE_LM_ENDPOINT_URL, useFakeLmDebugMode } from '@/services/fake-lm';
import type { ApprovalUiDecision } from '@/services/approval';

const { addToast } = useToast();
const { fakeLmDebugModeAvailability } = useFakeLmDebugMode();
const { openFileExplorer } = useFileExplorerModal();
const { getNaidanSysfsAccessScope } = useChatWeshPreferences();
const { state: previewState, closePreview } = useImagePreview({ scoped: true });
const { deleteBinaryObject, downloadBinaryObject } = useBinaryActions();
const {
  mediaShelfVisibility,
  setMediaShelfVisibility,
  toggleMediaShelf,
  isChatWeshTerminalOpen,
  toggleChatWeshTerminal,
} = useLayout();
const approval = useApproval();
const choices = useChoices();
const chatConversation = useChatConversation();
const chatBranches = useChatBranches();
const chatCompaction = useChatCompaction();
const chatGroups = useChatGroups();
const chatModels = useChatModels();
const chatTitle = useChatTitle();
const chatMetadata = useChatMetadata();
const { getSortedImageModels } = useImageGeneration();
const props = defineProps<{
  chatId: ChatId,
  autoSendPrompt?: string,
  targetMessageId?: MessageId,
}>();

const emit = defineEmits<{
  (e: 'auto-sent'): void,
}>();

const chatId = computed(() => props.chatId);
const chatPaneState = useChatPaneState({
  chatId,
});
const chat = chatPaneState.chat;
const chatGroup = chatPaneState.chatGroup;
const activeMessages = chatPaneState.activeMessages;
const allMessages = chatPaneState.allMessages;
const resolvedSettings = chatPaneState.resolvedSettings;
const inheritedSettings = chatPaneState.inheritedSettings;
const availableChatGroups = chatPaneState.chatGroups;
const availableModels = chatModels.availableModels;
const fetchingModels = chatModels.fetchingModels;
const isProcessing = computed(() => isChatProcessing({ chatId: props.chatId }));
const {
  chatFlow,
  isThinkingActive,
  isWaitingResponse,
} = useChatDisplayFlow({
  chat,
  isProcessing: ({ chatId }) => isChatProcessing({ chatId }),
});
const contextCompactProgress = computed<ContextCompactProgress>(() => getChatContextCompactProgress({ chatId: props.chatId }));
const activeApprovalRequest = computed(() => approval.getActiveApprovalRequest({ chatId: props.chatId }).value);
const activeChoiceRequest = computed(() => choices.getActiveChoiceRequest({ chatId: props.chatId }).value);
const isGeneratingTitle = computed(() => isChatGeneratingTitle({ chatId: props.chatId }));
const isDebugEnabled = computed(() => chat.value?.debugEnabled === true);
const chatIdentityKey = computed(() => {
  const chatId = props.chatId;
  const leafId = chat.value?.currentLeafId ?? 'no-leaf';
  return `${idToRaw({ id: chatId })}:${leafId === 'no-leaf' ? leafId : idToRaw({ id: leafId })}`;
});

const chatAreaSession = useChatPaneSession({
  chatIdentityKey,
});
const {
  showCompactSettings,
  showNeuralSyncEffect,
  outlineVisibility,
  initialOutlineMessageId,
  openCompactSettings,
  closeCompactSettings,
  closeOutline,
  playNeuralSyncEffect,
} = chatAreaSession;

const availableImageModels = computed(() => {
  return getSortedImageModels({ availableModels: availableModels.value });
});

const chatAreaNaidanSysfsAccessScope = computed(() => {
  return getNaidanSysfsAccessScope({ chatId: props.chatId });
});

const contextCompactPromptMode = computed<ContextCompactPromptMode>(() => {
  const accessScope = chatAreaNaidanSysfsAccessScope.value;
  switch (accessScope) {
  case 'none':
    return 'without_message_ids';
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats':
    return 'with_message_ids';
  default: {
    const _ex: never = accessScope;
    throw new Error(`Unhandled naidan sysfs access scope: ${_ex}`);
  }
  }
});

const initialContextCompactInstruction = computed(() => {
  return createCompactInstruction({
    promptMode: contextCompactPromptMode.value,
  });
});

const { setActiveFocusArea } = useLayout();
type ChatInputVisibility = 'submerged' | 'peeking' | 'active';
type ScrollForce = 'force' | 'if-near-bottom';
const inputVisibility = ref<ChatInputVisibility>('active');
const isAnimatingHeight = ref(false);
const isDragging = ref(false);

function handleDragOver({ event }: { event: DragEvent }) {
  event.preventDefault();
  isDragging.value = true;
}

function handleDragLeave({ event }: { event: DragEvent }) {
  // Only set to false if we are leaving the main container
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (
    event.clientX <= rect.left ||
    event.clientX >= rect.right ||
    event.clientY <= rect.top ||
    event.clientY >= rect.bottom
  ) {
    isDragging.value = false;
  }
}

async function handleDrop({ event }: { event: DragEvent }) {
  event.preventDefault();
  isDragging.value = false;

  if (event.dataTransfer?.items) {
    // Pass DataTransferItem[] to processDropItems which handles files AND directories.
    // Items must be collected here (synchronously) before any await, as the DataTransfer
    // object is cleared when control returns to the browser event loop.
    await chatInputRef.value?.processDropItems({ items: Array.from(event.dataTransfer.items) });
  }
}

const container = ref<HTMLElement | null>(null);

const {
  settings,
  save: saveSettings,
  setFakeLmDebugModeStatus,
} = useSettings();
const router = useRouter();

const isChatStreaming = computed(() => {
  return chat.value ? isProcessing.value : false;
});

// The index of the single flow item that should display the GeneratingIndicator.
// Only the very last item during streaming gets the indicator — never more than one.
const generatingIndicatorIndex = computed(() => {
  if (!isChatStreaming.value) return -1;
  return chatFlow.value.length - 1;
});

const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null);

const showChatSettings = ref(false);
const showHistoryModal = ref(false);
const showTitleDialog = ref(false);
const generatedTitleHistory = ref<string[]>([]);

function getCurrentViewportMessageId() {
  const scrollContainer = container.value;
  if (!scrollContainer) return undefined;

  const containerRect = scrollContainer.getBoundingClientRect();
  const targetY = containerRect.top + Math.min(120, containerRect.height * 0.25);
  const messageElements = Array.from(scrollContainer.querySelectorAll('[id^="message-"]'));

  let closest: { id: MessageId, distance: number } | undefined;
  for (const element of messageElements) {
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) continue;

    const distance = Math.abs(rect.top - targetY);
    if (!closest || distance < closest.distance) {
      closest = {
        id: toMessageId({ raw: element.id.replace(/^message-/, '') }),
        distance,
      };
    }
  }

  return closest?.id;
}

function toggleOutline() {
  chatAreaSession.toggleOutline({
    getCurrentViewportMessageId: () => getCurrentViewportMessageId(),
  });
}

function jumpToOutlineMessage({ messageId }: { messageId: MessageId }) {
  jumpToMessage({ messageId });
  closeOutline();
}

function clearTargetMessageQuery() {
  const currentQuery = router.currentRoute?.value?.query ?? {};
  if (!currentQuery['message-id']) return;

  const query = { ...currentQuery };
  delete query['message-id'];
  router.replace({ query });
}

async function handleMoveToGroup({ groupId }: { groupId: ChatGroupId | null }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  await chatGroups.moveChatToGroup({
    chatId: chatValue.id,
    chatGroupId: groupId ?? undefined,
  });
}

async function handleSaveTitle({ title }: { title: string }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  await chatMetadata.rename({
    chatId: chatValue.id,
    title,
  });
}

async function handleGenerateTitle({ modelId }: { modelId: string | undefined }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  const chatId = chatValue.id;
  const chatGroupId = chatValue.groupId ?? undefined;
  const titleBeforeGeneration = chatValue.title?.trim();
  await updateActiveTitleModel({
    source: activeTitleModelSource.value,
    chatId,
    chatGroupId,
    modelId,
  });
  const generatedTitle = await chatTitle.generateTitle({
    chatId,
    signal: undefined,
    titleModelIdOverride: modelId,
  });
  if (!generatedTitle) return;
  const nextHistory = titleBeforeGeneration
    ? [generatedTitle, titleBeforeGeneration, ...generatedTitleHistory.value]
    : [generatedTitle, ...generatedTitleHistory.value];
  generatedTitleHistory.value = Array.from(new Set(nextHistory));
}

function handleAbortTitleGeneration() {
  const chatValue = chat.value;
  if (!chatValue) return;
  chatTitle.abortTitleGeneration({
    chatId: chatValue.id,
  });
}

async function exportChat() {
  if (!chat.value || !chatFlow.value) return;

  const [newChatTitle, userLabel, aiLabel, systemLabel, toolLabel, thoughtLabel, toolExecutionsLabel, binaryObjectMissing, binaryErrorDetailMissing, toolStillExecuting, argumentsLabel, resultLabel, processSequenceLabel] = await Promise.all([
    ensureStrings.SHARED__new_chat(),
    ensureStrings.ChatPane__user(),
    ensureStrings.ChatPane__ai(),
    ensureStrings.ChatPane__system(),
    ensureStrings.ChatPane__tool(),
    ensureStrings.ChatPane__thought(),
    ensureStrings.ChatPane__tool_executions(),
    ensureStrings.ChatPane__binary_object_missing(),
    ensureStrings.ChatPane__binary_error_detail_missing(),
    ensureStrings.ChatPane__tool_still_executing(),
    ensureStrings.ChatPane__arguments(),
    ensureStrings.ChatPane__result(),
    ensureStrings.ChatPane__process_sequence(),
  ]);
  let markdownContent = `# ${chat.value.title || newChatTitle}\n\n`;

  const processFlowItems = async ({ items }: { items: ChatFlowItem[] }) => {
    for (const item of items) {
      const itemType = item.type;
      switch (itemType) {
      case 'message': {
        const msg = item.node;
        const role = (() => {
          const r = msg.role;
          switch (r) {
          case 'user': return userLabel;
          case 'assistant': return aiLabel;
          case 'system': return systemLabel;
          case 'tool': return toolLabel;
          default: {
            const _ex: never = r;
            return (_ex as string);
          }
          }
        })();
        const prefix = (() => {
          const mode = item.mode;
          switch (mode) {
          case 'thinking': return `[${thoughtLabel}]: `;
          case 'content':
          case 'tool_calls':
          case 'waiting':
            return '';
          default: {
            const _ex: never = mode;
            return _ex;
          }
          }
        })();
        markdownContent += `## ${role}:\n${prefix}${item.partContent || msg.content}\n\n`;
        break;
      }
      case 'tool_group': {
        markdownContent += `## ${toolExecutionsLabel}:\n`;
        for (const tc of item.toolCalls) {
          let resultStr = '';
          const status = tc.result.status;
          switch (status) {
          case 'success': {
            const contentType = tc.result.content.type;
            switch (contentType) {
            case 'text':
              resultStr = tc.result.content.text;
              break;
            case 'binary_object': {
              const blob = await storageService.getFile({ binaryObjectId: tc.result.content.id });
              resultStr = blob ? await blob.text() : binaryObjectMissing;
              break;
            }
            default: {
              const _ex: never = contentType;
              resultStr = `[Unknown content type: ${_ex}]`;
            }
            }
            break;
          }
          case 'error': {
            const messageType = tc.result.error.message.type;
            switch (messageType) {
            case 'text':
              resultStr = tc.result.error.message.text;
              break;
            case 'binary_object': {
              const blob = await storageService.getFile({ binaryObjectId: tc.result.error.message.id });
              const detail = blob ? await blob.text() : binaryErrorDetailMissing;
              resultStr = `Error [${tc.result.error.code}]: ${detail}`;
              break;
            }
            default: {
              const _ex: never = messageType;
              resultStr = `[Unknown error message type: ${_ex}]`;
            }
            }
            break;
          }
          case 'executing':
            resultStr = toolStillExecuting;
            break;
          default: {
            const _ex: never = status;
            resultStr = `[Unknown status: ${_ex}]`;
          }
          }
          markdownContent += `### ${tc.call.function.name}\n${argumentsLabel}: ${tc.call.function.arguments}\n${resultLabel}: ${resultStr}\n\n`;
        }
        break;
      }
      case 'process_sequence':
        markdownContent += `## ${processSequenceLabel}: ${item.summary}\n`;
        await processFlowItems({ items: item.items });
        break;
      default: {
        const _ex: never = itemType;
        console.warn(`Unhandled ChatFlowItem type: ${_ex}`);
      }
      }
    }
  };

  await processFlowItems({ items: chatFlow.value });

  const blob = new Blob([markdownContent], { type: 'text/plain;charset=utf-8' });
  const filename = `${chat.value.title || 'new_chat'}.txt`;

  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

async function shareAsURL() {
  if (!chat.value) return;

  try {
    const url = await generateChatShareURL({ chatId: chat.value.id });
    await navigator.clipboard.writeText(url);
    addToast({
      message: await ensureStrings.ChatPane__share_url_copied_to_clipboard(),
      duration: 3000,
    });
  } catch (err) {
    addToast({
      message: await ensureStrings.ChatPane__failed_to_generate_share_url({ errorMessage: err instanceof Error ? err.message : String(err) }),
      duration: 5000,
    });
  }
}

async function openChatFileExplorer() {
  if (!chat.value) return;

  const mounts = await buildWorkerMountsForChat({
    chatMounts: chat.value.mounts ?? [],
    chatGroupMounts: chatGroup.value?.mounts,
    chatId: chat.value.id,
    chatGroupId: chat.value.groupId ?? undefined,
    naidanSysfsAccessScope: chatAreaNaidanSysfsAccessScope.value,
  });

  openFileExplorer({ options: {
    kind: 'wesh-mounts',
    title: await ensureStrings.fileExplorer__files(),
    rootName: await ensureStrings.fileExplorer__files(),
    mounts,
    initialPath: undefined,
  } });
}

async function handlePrint(): Promise<void> {
  if (chat.value) {
    usePrint().print({
      title: chat.value.title || await ensureStrings.ChatPane__chat(),
      mode: 'chat',
    });
  }
}

function scrollToBottom({ scrollForce, behavior }: { scrollForce: ScrollForce, behavior: ScrollBehavior }) {
  if (container.value) {
    const { scrollTop, scrollHeight, clientHeight } = container.value;
    // Only auto-scroll if forced (new message) or already near the bottom
    if (scrollForce === 'force' || scrollHeight - scrollTop - clientHeight < 150) {
      container.value.scrollTo({ top: scrollHeight, behavior });
    }
  }
}

async function waitForPaint({ frames }: { frames: number }) {
  if (typeof window === 'undefined') return;
  for (let index = 0; index < frames; index++) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

async function scrollAnchorToTop({ target, behavior, offset }: { target: ChatPaneScrollTarget, behavior: ScrollBehavior, offset: number }) {
  if (!container.value) return false;

  let el: HTMLElement | null = null;
  for (let i = 0; i < 5; i++) {
    await nextTick();
    el = container.value.querySelector(`#${target.anchorId}`) as HTMLElement | null;
    if (el) break;
  }

  if (!(el instanceof HTMLElement)) return false;

  scrollIntoViewSafe({
    container: container.value,
    element: el,
    behavior,
    block: 'start',
    offset,
  });
  return true;
}

async function scrollUserTurnToTop({ userTurnId, behavior }: { userTurnId: MessageId, behavior: ScrollBehavior }) {
  return scrollAnchorToTop({
    target: {
      kind: 'message',
      anchorId: `message-${idToRaw({ id: userTurnId })}`,
      messageId: userTurnId,
    },
    behavior,
    offset: 0,
  });
}

async function scrollInitialOpenTarget({ target }: { target: ChatPaneInitialOpenTarget }) {
  switch (target.kind) {
  case 'bottom':
    scrollToBottom({ scrollForce: 'force', behavior: 'instant' });
    return;
  case 'message':
  case 'process_sequence':
  case 'tool_group': {
    const didScroll = await scrollAnchorToTop({ target, behavior: 'instant', offset: 50 });
    if (!didScroll) {
      scrollToBottom({ scrollForce: 'force', behavior: 'instant' });
    }
    return;
  }
  default: {
    const _ex: never = target;
    throw new Error(`Unhandled initial scroll target: ${_ex}`);
  }
  }
}

function jumpToMessage({ messageId }: { messageId: MessageId }): boolean {
  if (!container.value) return false;
  const el = container.value.querySelector(`#message-${idToRaw({ id: messageId })}`);
  if (el instanceof HTMLElement) {
    scrollIntoViewSafe({
      container: container.value,
      element: el,
      behavior: 'smooth',
      block: 'center',
    });
    el.classList.add('bg-blue-50/50', 'dark:bg-blue-900/20');
    setTimeout(() => {
      el.classList.remove('bg-blue-50/50', 'dark:bg-blue-900/20');
    }, 2000);
    return true;
  }
  return false;
}

const lastJumpedTargetMessageKey = ref<string | undefined>(undefined);

watch(
  () => {
    const flowKey = chatFlow.value.map((item) => {
      switch (item.type) {
      case 'message':
        return `${idToRaw({ id: item.node.id })}:${item.mode}`;
      case 'process_sequence':
        return `${item.id}:${item.items.length}`;
      case 'tool_group':
        return item.id;
      default: {
        const _ex: never = item;
        return _ex;
      }
      }
    }).join('|');
    return {
      messageId: props.targetMessageId,
      chatId: props.chatId,
      leafId: chat.value?.currentLeafId,
      flowKey,
    };
  },
  async ({ messageId, chatId, leafId, flowKey }) => {
    if (!messageId) {
      lastJumpedTargetMessageKey.value = undefined;
      return;
    }
    const targetKey = `${chatId === undefined ? '' : idToRaw({ id: chatId })}:${leafId === undefined ? '' : idToRaw({ id: leafId })}:${idToRaw({ id: messageId })}:${flowKey}`;
    if (lastJumpedTargetMessageKey.value === targetKey) return;

    await nextTick();
    await waitForPaint({ frames: 1 });
    if (jumpToMessage({ messageId })) {
      lastJumpedTargetMessageKey.value = targetKey;
    }
  },
  { flush: 'post', immediate: true },
);

// Expose for testing and current chat pane forwarding.
defineExpose({ scrollToBottom, container, inputVisibility,
  TEST_ONLY: {
    // Export internal state and logic used only for testing here. Do not reference these in production logic.
  },
});

const canGenerateImage = computed(() => {
  const type = resolvedSettings.value?.endpointType;
  if (!type) return false;

  const isOllama = (() => {
    switch (type) {
    case 'ollama':
      return true;
    case 'openai':
    case 'transformers_js':
      return false;
    default: {
      const _ex: never = type;
      throw new Error(`Unhandled endpoint type: ${_ex}`);
    }
    }
  })();

  if (!isOllama) return false;
  return availableImageModels.value.length > 0;
});
const hasImageModel = computed(() => availableImageModels.value.length > 0);

const chatGroupBadge = computed(() => {
  const groupId = chat.value?.groupId;
  if (!groupId) return undefined;
  return availableChatGroups.value.find(group => group.id === groupId);
});

const currentModelLabel = computed(() => formatSettingsSourceLabel({
  value: resolvedSettings.value?.modelId,
  source: resolvedSettings.value?.sources.modelId,
}));

const activeTitleModelSource = computed<SettingsSource>(() => resolvedSettings.value?.sources.titleModelId ?? 'global');

const activeTitleModelId = computed(() => {
  const source = activeTitleModelSource.value;
  switch (source) {
  case 'chat':
    return chat.value?.titleModelId;
  case 'chat_group':
    return chatGroup.value?.titleModelId;
  case 'global':
    return settings.value.titleModelId;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled title model source: ${_ex}`);
  }
  }
});

async function updateActiveTitleModel({
  source,
  chatId,
  chatGroupId,
  modelId,
}: {
  source: SettingsSource,
  chatId: ChatId,
  chatGroupId: ChatGroupId | undefined,
  modelId: string | undefined,
}) {
  switch (source) {
  case 'chat':
    await chatMetadata.updateScopedSettings({
      chatId,
      changes: [modelId === undefined
        ? { field: 'title_model_id', behavior: 'inherit' }
        : { field: 'title_model_id', behavior: 'override', value: modelId }],
    });
    return;
  case 'chat_group':
    if (chatGroupId === undefined) {
      await saveSettings({ patch: { titleModelId: modelId } });
      return;
    }
    await chatGroups.updateScopedSettings({
      chatGroupId,
      changes: [modelId === undefined
        ? { field: 'title_model_id', behavior: 'inherit' }
        : { field: 'title_model_id', behavior: 'override', value: modelId }],
    });
    return;
  case 'global':
    await saveSettings({ patch: { titleModelId: modelId } });
    return;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled title model source: ${_ex}`);
  }
  }
}

function handleSearchChatFromHeader() {
  if (chat.value) {
    useGlobalSearch().openSearch({ chatId: idToRaw({ id: chat.value.id }) });
  }
}

watch(
  showTitleDialog,
  (isOpen) => {
    if (isOpen) {
      generatedTitleHistory.value = [];
    }
  },
);

const autoScroll = useChatPaneAutoScroll({
  chat,
  activeMessages,
  chatFlow,
  processingStatus: computed(() => isChatStreaming.value ? 'processing' : 'idle'),
});

const responseViewportReserve = ref<{ chatId: ChatId, navigationKey: string, userTurnId: MessageId, heightPx: number } | undefined>(undefined);

const isResponseViewportReserveActive = computed(() => {
  if (props.targetMessageId) return false;

  const snapshot = autoScroll.snapshot.value;
  return !!responseViewportReserve.value
    && responseViewportReserve.value.chatId === snapshot.chatId
    && responseViewportReserve.value.navigationKey === snapshot.navigationKey
    && responseViewportReserve.value.userTurnId === snapshot.latestUserTurnId;
});

const responseViewportReserveHeightPx = computed(() => {
  if (!isResponseViewportReserveActive.value) return 0;
  return responseViewportReserve.value?.heightPx ?? 0;
});

function getElementTopInContainer({
  element,
  scrollContainer,
}: {
  element: HTMLElement,
  scrollContainer: HTMLElement,
}) {
  const containerRect = scrollContainer.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return scrollContainer.scrollTop + elementRect.top - containerRect.top;
}

function calculateResponseViewportReserveHeight({ userTurnId }: { userTurnId: MessageId }) {
  const scrollContainer = container.value;
  if (!scrollContainer) return 0;

  const userElement = scrollContainer.querySelector(`#message-${idToRaw({ id: userTurnId })}`);
  if (!(userElement instanceof HTMLElement)) return 0;

  const userTop = getElementTopInContainer({
    element: userElement,
    scrollContainer,
  });
  const currentReserveHeight = responseViewportReserve.value?.heightPx ?? 0;
  const scrollHeightWithoutReserve = scrollContainer.scrollHeight - currentReserveHeight;
  const maxScrollTopWithoutReserve = scrollHeightWithoutReserve - scrollContainer.clientHeight;
  return Math.max(0, Math.ceil(userTop - maxScrollTopWithoutReserve));
}

async function handleEdit({ messageId, newContent, lmParameters }: { messageId: MessageId, newContent: string, lmParameters?: LmParameters }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  await chatBranches.editMessage({
    chatId: chatValue.id,
    messageId,
    newContent,
    lmParameters,
  });
}

async function handleRegenerate({ messageId }: { messageId: MessageId }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  await chatConversation.regenerateMessage({
    chatId: chatValue.id,
    failedMessageId: messageId,
  });
}

async function handleCompactContext() {
  openCompactSettings();
}

async function handleConfirmCompact({
  keepCount,
  instruction,
}: {
  keepCount: number,
  instruction: string,
}) {
  closeCompactSettings();
  const chatValue = chat.value;
  if (!chatValue) return;
  const didCompact = await chatCompaction.compactCurrentBranch({
    chatId: chatValue.id,
    keepRecentMessages: keepCount,
    instructionOverride: instruction,
  });
  if (didCompact) {
    playNeuralSyncEffect();
  }
}

function handleAbortContextCompact() {
  const chatValue = chat.value;
  if (!chatValue) return;
  chatCompaction.abort({
    chatId: chatValue.id,
  });
}

function handleSwitchVersion({ messageId }: { messageId: MessageId }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  void chatBranches.switchVersion({
    chatId: chatValue.id,
    messageId,
  });
}

async function handleFork({ messageId }: { messageId: MessageId }) {
  const chatValue = chat.value;
  if (!chatValue) return;
  const newId = await chatBranches.forkChat({
    chatId: chatValue.id,
    messageId,
  });
  if (newId) {
    router.push(`/chat/${idToRaw({ id: newId })}`);
  }
}

function handleForkLastMessage() {
  // We need to find the last message across all potential levels of nesting in chatFlow
  const findLastMessage = ({ items }: { items: ChatFlowItem[] }): ChatFlowItem | null => {
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]!;
      const type = item.type;
      switch (type) {
      case 'message': return item;
      case 'process_sequence': {
        const nested = findLastMessage({ items: item.items });
        if (nested) return nested;
        break;
      }
      case 'tool_group':
        break;
      default: {
        const _ex: never = type;
        return _ex;
      }
      }
    }
    return null;
  };

  const lastMsgItem = findLastMessage({ items: chatFlow.value });
  if (lastMsgItem && lastMsgItem.type === 'message') {
    handleFork({ messageId: lastMsgItem.node.id });
  }
}

function getChatSiblings({ messageId }: { messageId: MessageId }) {
  const chatValue = chat.value;
  if (!chatValue) return [];
  return [...getSiblingsInChatBranch({
    root: chatValue.root,
    messageId,
  })];
}

function handleRefreshModels() {
  const chatValue = chat.value;
  if (!chatValue) return;
  void chatModels.fetchForChat({
    chatId: chatValue.id,
  });
}

function handleApprovalDecision({
  decision,
}: {
  decision: ApprovalUiDecision,
}): void {
  const request = activeApprovalRequest.value;
  if (request === undefined) {
    return;
  }
  approval.resolveApprovalRequest({
    requestId: request.requestId,
    decision,
  });
}

function handleChoiceSelection({
  index,
}: {
  index: number,
}): void {
  const request = activeChoiceRequest.value;
  if (request === undefined) {
    return;
  }
  choices.resolveChoiceRequest({
    requestId: request.requestId,
    index,
  });
}

function handleAbortGeneration() {
  const chatValue = chat.value;
  if (!chatValue) return;
  chatConversation.abort({
    chatId: chatValue.id,
  });
}

function handleToggleDebug() {
  const chatValue = chat.value;
  if (!chatValue) return;
  void chatMetadata.toggleDebug({
    chatId: chatValue.id,
  });
}

function canUseFakeLmDebugModeInChatPane(): boolean {
  const availability = fakeLmDebugModeAvailability.value;
  switch (availability) {
  case 'available':
    return true;
  case 'unavailable_in_standalone':
    return false;
  default: {
    const _ex: never = availability;
    throw new Error(`Unhandled fake LM debug mode availability: ${_ex}`);
  }
  }
}

async function handleEnableFakeLmForChat() {
  const chatValue = chat.value;
  if (!chatValue) return;
  if (!canUseFakeLmDebugModeInChatPane()) return;

  await setFakeLmDebugModeStatus({ status: 'enabled' });

  await chatMetadata.updateScopedSettings({
    chatId: chatValue.id,
    changes: [{
      field: 'endpoint',
      behavior: 'override',
      value: {
        type: 'ollama',
        url: FAKE_LM_ENDPOINT_URL,
      },
    }],
  });

  addToast({
    message: `Fake LM enabled for this chat via ${FAKE_LM_ENDPOINT_URL}`,
    duration: 3000,
  });
}

function jumpToOrigin() {
  if (chat.value?.originChatId) {
    router.push(`/chat/${idToRaw({ id: chat.value.originChatId })}`);
  }
}

watch(
  () => {
    const snapshot = autoScroll.snapshot.value;
    return [
      snapshot.chatId,
      snapshot.navigationKey,
      snapshot.processingStatus,
      snapshot.latestUserTurnId,
      snapshot.firstAssistantVisibleTarget?.kind,
      snapshot.firstAssistantVisibleTarget?.anchorId,
    ];
  },
  async () => {
    await nextTick();

    const action = autoScroll.consumeScrollAction();
    if (!action) return;
    if (props.targetMessageId) return;

    switch (action.kind) {
    case 'initial_open':
      responseViewportReserve.value = undefined;
      await scrollInitialOpenTarget({ target: action.target });
      break;
    case 'assistant': {
      const snapshot = autoScroll.snapshot.value;
      if (!snapshot.chatId || !snapshot.navigationKey) return;
      responseViewportReserve.value = {
        chatId: snapshot.chatId,
        navigationKey: snapshot.navigationKey,
        userTurnId: action.userTurnId,
        heightPx: 0,
      };
      await nextTick();
      const reserve = responseViewportReserve.value;
      if (!reserve) return;
      responseViewportReserve.value = {
        ...reserve,
        heightPx: calculateResponseViewportReserveHeight({ userTurnId: action.userTurnId }),
      };
      await nextTick();
      await waitForPaint({ frames: 2 });
      const didScroll = await scrollUserTurnToTop({ userTurnId: action.userTurnId, behavior: 'smooth' });
      if (didScroll) {
        autoScroll.markAssistantAutoScrolled({
          chatId: snapshot.chatId,
          navigationKey: snapshot.navigationKey,
          userTurnId: action.userTurnId,
        });
      }
      break;
    }
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled auto-scroll action: ${_ex}`);
    }
    }
  },
  { flush: 'post', immediate: true },
);
</script>

<template>
  <div
    class="chat-pane flex flex-col h-full bg-[#fcfcfd] dark:bg-gray-900 transition-colors relative"
    @dragover="handleDragOver({ event: $event })"
    @dragleave="handleDragLeave({ event: $event })"
    @drop="handleDrop({ event: $event })"
    @click="setActiveFocusArea({ area: 'chat' })"
  >
    <!-- Drag Overlay -->
    <div
      v-if="isDragging"
      class="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 pointer-events-none flex items-center justify-center"
      data-testid="drag-overlay"
    >
      <div class="bg-white dark:bg-gray-800 p-4 rounded-2xl shadow-xl flex items-center gap-3 animate-in zoom-in duration-200">
        <FolderInputIcon class="w-6 h-6 text-blue-500" />
        <span class="text-lg font-bold text-gray-800 dark:text-gray-100">{{ lazyStrings.ChatPane__drop_files_or_folders_to_attach() }}</span>
      </div>
    </div>

    <ChatPaneHeader
      :chat="chat"
      :chat-groups="availableChatGroups"
      :chat-group-badge="chatGroupBadge"
      :active-message-count="activeMessages.length"
      :model-label="currentModelLabel"
      :has-overrides="!!(chat && hasChatOverrides({ chat }))"
      :show-chat-settings="showChatSettings"
      :outline-visibility="outlineVisibility"
      :generating-title="isGeneratingTitle"
      :media-shelf-visibility="mediaShelfVisibility"
      :is-chat-wesh-terminal-open="isChatWeshTerminalOpen"
      @jump-origin="jumpToOrigin"
      @edit-title="showTitleDialog = true"
      @update:show-chat-settings="showChatSettings = $event"
      @fork-last-message="handleForkLastMessage"
      @move-to-group="groupId => handleMoveToGroup({ groupId })"
      @toggle-outline="toggleOutline()"
      @print="handlePrint"
      @search-chat="handleSearchChatFromHeader"
      @open-history="showHistoryModal = true"
      @compact-context="handleCompactContext()"
      @export-chat="exportChat"
      @toggle-media-shelf="toggleMediaShelf"
      @share-url="shareAsURL"
      @open-file-explorer="openChatFileExplorer()"
      @toggle-wesh-terminal="toggleChatWeshTerminal"
      @toggle-debug="handleToggleDebug()"
    />

    <!-- Chat Settings Panel -->
    <ChatSettingsPanel
      :show="showChatSettings"
      @close="showChatSettings = false"
    />

    <ChatTitleDialog
      :is-open="showTitleDialog"
      :title="chat?.title ?? null"
      :available-models="availableModels"
      :selected-title-model="activeTitleModelId"
      :title-model-source="activeTitleModelSource"
      :generated-titles="generatedTitleHistory"
      :generating-title="isGeneratingTitle"
      :fetching-models="fetchingModels"
      @close="showTitleDialog = false"
      @save-title="title => handleSaveTitle({ title })"
      @generate-title="modelId => handleGenerateTitle({ modelId })"
      @abort-title="handleAbortTitleGeneration()"
      @refresh-models="handleRefreshModels()"
    />

    <!-- History Manipulation Modal -->
    <HistoryManipulationModal
      :is-open="showHistoryModal"
      @close="showHistoryModal = false"
    />

    <!-- Context Compact Settings Dialog -->
    <ContextCompactSettingsDialog
      :is-open="showCompactSettings"
      :total-messages="activeMessages.length"
      :initial-keep-count="6"
      :initial-instruction="initialContextCompactInstruction"
      @close="closeCompactSettings()"
      @confirm="({ keepCount, instruction }) => handleConfirmCompact({ keepCount, instruction })"
    />

    <!-- Chat Wesh Terminal Modal -->
    <ChatWeshTerminalModal
      :is-open="isChatWeshTerminalOpen"
      :chat-mounts="chat?.mounts"
      :chat-group-mounts="chatGroup?.mounts"
      :chat-id="props.chatId"
      :chat-group-id="chat?.groupId ?? undefined"
      :naidan-sysfs-access-scope="chatAreaNaidanSysfsAccessScope"
      @close="toggleChatWeshTerminal()"
    />

    <!-- Messages Layer -->
    <div class="flex-1 relative overflow-hidden">
      <div
        class="absolute inset-x-0 top-0 z-40 pointer-events-none"
        data-testid="context-compact-progress-overlay"
      >
        <div class="pointer-events-auto">
          <ContextCompactProgressStrip
            :progress="contextCompactProgress"
            @abort="handleAbortContextCompact()"
          />
        </div>
      </div>

      <!-- Neural Sync Effect Overlay -->
      <div
        v-if="showNeuralSyncEffect"
        class="absolute inset-0 z-50 pointer-events-none overflow-hidden"
        data-testid="context-compact-neural-sync-effect"
      >
        <div class="neural-scan-line"></div>
        <div class="neural-flash-overlay"></div>
      </div>

      <ConversationOutlineOverlay
        v-if="chat"
        :chat-id="props.chatId"
        :visibility="outlineVisibility"
        :flow-items="chatFlow"
        :initial-message-id="initialOutlineMessageId"
        @close="closeOutline()"
        @select-message="(messageId) => jumpToOutlineMessage({ messageId })"
      />
      <div
        ref="container"
        data-testid="scroll-container"
        class="absolute inset-0 overflow-y-auto overscroll-contain transition-[padding-bottom] duration-500"
        style="overflow-anchor: none;"
        :style="{ paddingBottom: inputVisibility === 'submerged' ? '48px' : '300px' }"
      >
        <template v-if="chat">
          <div v-if="activeMessages.length > 0" class="relative p-2">
            <template v-for="(flowItem, flowIdx) in chatFlow" :key="flowItem.type === 'process_sequence' ? flowItem.id : (flowItem.type === 'message' ? `${flowItem.node.id}-${flowItem.mode}` : flowItem.id)">
              <!-- AI Process Sequence (Collapsible Group) -->
              <AssistantProcessSequence
                v-if="flowItem.type === 'process_sequence'"
                :id="'process-sequence-' + flowItem.id"
                :items="flowItem.items"
                :is-processing="isChatStreaming"
                :flow="flowItem.flow"
                :summary="flowItem.summary"
                :stats="flowItem.stats"
                :is-first-in-turn="flowItem.isFirstInTurn"
              >
                <template #cursor>
                  <GeneratingIndicator v-if="flowIdx === generatingIndicatorIndex" class="ml-1" />
                </template>
                <template #peek>
                  <template v-if="flowItem.type === 'process_sequence' && flowItem.items.length > 0">
                    <template v-for="lastItem in ([flowItem.items[flowItem.items.length - 1]] as ChatFlowItem[])" :key="lastItem.type === 'message' ? lastItem.node.id : lastItem.id">
                      <!-- Active Thinking Peek -->
                      <MessageThinking
                        v-if="lastItem.type === 'message' && isThinkingActive({ item: lastItem })"
                        :message="lastItem.node"
                        :part-content="lastItem.partContent"
                        no-margin
                      />
                      <!-- Waiting Peek (Initial loading within sequence) -->
                      <AssistantWaitingIndicator
                        v-else-if="lastItem.type === 'message' && isWaitingResponse({ item: lastItem })"
                        no-padding
                      />
                    </template>
                  </template>
                </template>
                <template #default="{ isExpanded }">
                  <template v-for="subItem in (flowItem.items as ChatFlowItem[])" :key="subItem.type === 'message' ? `${subItem.node.id}-${subItem.mode}` : subItem.id">
                    <MessageItem
                      v-if="subItem.type === 'message' && isExpanded"
                      :id="'message-' + subItem.node.id"
                      :chat-id="props.chatId"
                      :message="subItem.node"
                      :siblings="getChatSiblings({ messageId: subItem.node.id })"
                      :can-generate-image="canGenerateImage && hasImageModel"
                      :is-processing="isChatStreaming"
                      :is-generating="isChatStreaming && subItem.node.id === chat?.currentLeafId"
                      :available-image-models="availableImageModels"
                      :endpoint-type="resolvedSettings?.endpointType"
                      :flow="subItem.flow"
                      :mode="subItem.mode"
                      :part-content="subItem.partContent"
                      :is-first-in-node="subItem.isFirstInNode"
                      :is-last-in-node="subItem.isLastInNode"
                      :is-first-in-turn="subItem.isFirstInTurn"
                      @fork="messageId => handleFork({ messageId })"
                      @edit="(id, content, params) => handleEdit({ messageId: id, newContent: content, lmParameters: params })"
                      @switch-version="messageId => handleSwitchVersion({ messageId })"
                      @regenerate="messageId => handleRegenerate({ messageId })"
                      @abort="handleAbortGeneration()"
                    />
                    <ToolCallGroupItem
                      v-else-if="subItem.type === 'tool_group' && isExpanded"
                      :tool-calls="subItem.toolCalls"
                      :flow="subItem.flow"
                      :is-first-in-turn="subItem.isFirstInTurn"
                    />
                  </template>
                </template>
              </AssistantProcessSequence>

              <!-- Standard Message -->
              <MessageItem
                v-else-if="flowItem.type === 'message'"
                :id="'message-' + flowItem.node.id"
                :chat-id="props.chatId"
                :message="flowItem.node"
                :siblings="getChatSiblings({ messageId: flowItem.node.id })"
                :can-generate-image="canGenerateImage && hasImageModel"
                :is-processing="isChatStreaming"
                :is-generating="isChatStreaming && flowItem.node.id === chat?.currentLeafId"
                :available-image-models="availableImageModels"
                :endpoint-type="resolvedSettings?.endpointType"
                :flow="flowItem.flow"
                :mode="flowItem.mode"
                :part-content="flowItem.partContent"
                :is-first-in-node="flowItem.isFirstInNode"
                :is-last-in-node="flowItem.isLastInNode"
                :is-first-in-turn="flowItem.isFirstInTurn"
                :show-generating-indicator="flowIdx === generatingIndicatorIndex"
                @fork="messageId => handleFork({ messageId })"
                @edit="(id, content, params) => handleEdit({ messageId: id, newContent: content, lmParameters: params })"
                @switch-version="messageId => handleSwitchVersion({ messageId })"
                @regenerate="messageId => handleRegenerate({ messageId })"
                @abort="handleAbortGeneration()"
              />

              <!-- Standalone Tool Group -->
              <ToolCallGroupItem
                v-else-if="flowItem.type === 'tool_group'"
                :id="'tool-group-' + flowItem.id"
                :tool-calls="flowItem.toolCalls"
                :flow="flowItem.flow"
                :is-first-in-turn="flowItem.isFirstInTurn"
              />
            </template>

            <!-- Global Transformers.js Loading Indicator in the scroll flow -->
            <TransformersJsLoadingIndicator
              v-if="resolvedSettings?.endpointType === 'transformers_js'"
              mode="full"
            />
            <div
              v-if="isResponseViewportReserveActive && responseViewportReserveHeightPx > 0"
              class="shrink-0 pointer-events-none"
              :style="{ height: `${responseViewportReserveHeightPx}px` }"
              data-testid="response-viewport-reserve"
            ></div>
          </div>
          <WelcomeScreen
            v-else
            :has-input="(chatInputRef?.input || '').trim().length > 0"
            @select-suggestion="(text) => chatInputRef?.applySuggestion({ text })"
          />
        </template>

        <!-- Conditional spacer: only large when maximized or animating to allow scrolling hidden content -->
        <div
          v-if="chatInputRef?.isMaximized || isAnimatingHeight"
          class="h-[75vh] shrink-0 pointer-events-none"
          data-testid="maximized-spacer"
        ></div>
      </div>

      <!-- Chat State Inspector (Debug Mode) -->
      <ChatDebugInspector
        v-if="isDebugEnabled"
        :show="isDebugEnabled"
        :chat="chat"
        :active-messages="activeMessages"
        @close="handleToggleDebug()"
        @enable-fake-lm="handleEnableFakeLmForChat()"
        data-testid="chat-inspector"
      />
    </div>

    <!-- Input Layer -->
    <ChatMediaShelf
      v-if="chat && mediaShelfVisibility === 'visible'"
      :chat-id="chat.id"
      :messages="allMessages"
      @close="setMediaShelfVisibility({ visibility: 'hidden' })"
      @jump-to-message="(id) => jumpToMessage({ messageId: id })"
    />
    <ChatInput
      v-if="chat"
      ref="chatInputRef"
      :chat-id="chat.id"
      :chat="chat"
      :chat-group="chatGroup"
      :resolved-lm-parameters="resolvedSettings?.lmParameters"
      :inherited-model-id="inheritedSettings?.modelId"
      :inherited-model-source="inheritedSettings?.sources.modelId"
      v-model:visibility="inputVisibility"
      v-model:is-animating-height="isAnimatingHeight"
      :above-input-visibility="activeApprovalRequest !== undefined || activeChoiceRequest !== undefined ? 'visible' : 'hidden'"
      :is-streaming="isChatStreaming"
      :can-generate-image="canGenerateImage"
      :has-image-model="hasImageModel"
      :available-image-models="availableImageModels"
      :auto-send-prompt="autoSendPrompt"
      @auto-sent="emit('auto-sent')"
      @sent="clearTargetMessageQuery"
      @scroll-to-bottom="(force) => scrollToBottom({ scrollForce: force ? 'force' : 'if-near-bottom', behavior: 'smooth' })"
    >
      <template #above-input>
        <ChatApprovalPanel
          v-if="activeApprovalRequest !== undefined"
          :request="activeApprovalRequest"
          @decide="decision => handleApprovalDecision({ decision })"
        />
        <ChatChoicesPanel
          v-else-if="activeChoiceRequest !== undefined"
          :request="activeChoiceRequest"
          @select="index => handleChoiceSelection({ index })"
        />
      </template>
    </ChatInput>

    <!-- Preview Modal -->
    <BinaryObjectPreviewModal
      v-if="previewState"
      :objects="previewState.objects"
      :initial-id="previewState.initialId"
      @close="closePreview"
      @delete="(obj) => deleteBinaryObject({ id: obj.id })"
      @download="(obj) => downloadBinaryObject({ obj })"
    />
  </div>
</template>

<style scoped>
/* Neural Sync Effect Animations */
@keyframes neural-scan {
  0% { transform: translateY(-100%); opacity: 0; }
  10% { opacity: 1; }
  90% { opacity: 1; }
  100% { transform: translateY(100vh); opacity: 0; }
}

@keyframes neural-flash {
  0% { opacity: 0; }
  20% { opacity: 0.15; background-color: #6366f1; } /* indigo-500 */
  100% { opacity: 0; }
}

.neural-scan-line {
  position: absolute;
  top: 0; left: 0; right: 0; height: 120px;
  background: linear-gradient(to bottom, transparent, #6366f1, transparent);
  box-shadow: 0 0 50px rgba(99, 102, 241, 0.4);
  animation: neural-scan 1s cubic-bezier(0.65, 0, 0.35, 1) forwards;
  z-index: 60;
}

.neural-flash-overlay {
  position: absolute;
  inset: 0;
  animation: neural-flash 1s ease-out forwards;
  z-index: 55;
}

/* Dropdown Transition */
.dropdown-enter-active,
.dropdown-leave-active {
  transition: all 0.2s ease;
}

.dropdown-enter-from,
.dropdown-leave-to {
  opacity: 0;
  transform: scale(0.95) translateY(-10px);
}
</style>
