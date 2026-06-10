import type { ChatGroup, SidebarItem } from '@/models/types';
import {
  buildCompactRequestMessages,
  createCompactBranchFromResponse,
  createCompactChatMessagesFromPrefix,
  createCompactRequestPreview,
  createProviderForCompact,
  getHeaderCompactBoundary,
  splitCompactPath,
  type ContextCompactPromptMode,
} from '@/services/context-compact';
import { resolveChatSettings } from '@/utils/chat-settings-resolver';
import { getChatBranchIterator } from '@/utils/chat-tree';
import { generateId } from '@/utils/id';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { useSettings } from '@/composables/useSettings';
import { useChatWeshPreferences } from '@/composables/useChatWeshPreferences';
import {
  chatRuntimeStore,
  contextCompactRuntime,
  getLiveChat,
  getLiveChatById,
  getReadonlyChat,
  isProcessing,
  registerLiveInstance,
  rootItems,
  triggerCurrentChat as notifyChatChanged,
  updateChatContent,
  updateChatMeta,
} from '@/composables/chat/global/chat-core-singletons';

export type CompactCurrentBranchResult =
  | {
      status: 'compacted';
      chatId: string;
      compactNodeId: string;
      currentLeafId: string;
    }
  | {
      status: 'skipped';
      reason:
        | 'no_current_chat'
        | 'already_processing'
        | 'not_enough_messages'
        | 'empty_prefix'
        | 'missing_model_or_endpoint'
        | 'empty_response';
    }
  | {
      status: 'aborted';
    };

export async function runCompactCurrentBranchForChat({
  chatId,
  keepRecentMessages,
  instructionOverride,
}: {
  chatId: string;
  keepRecentMessages: number;
  instructionOverride: string | undefined;
}): Promise<CompactCurrentBranchResult> {
  const targetChat = getLiveChatById({ chatId });
  if (targetChat === null) {
    return { status: 'skipped', reason: 'no_current_chat' };
  }

  const mutableChat = getLiveChat({ chat: targetChat });
  if (isProcessing({ chatId: mutableChat.id })) {
    return { status: 'skipped', reason: 'already_processing' };
  }

  const path = Array.from(getChatBranchIterator({ chat: mutableChat }));
  const boundaryMessageId = getHeaderCompactBoundary({
    path,
    keepRecentMessages,
  });
  if (boundaryMessageId === undefined) {
    return { status: 'skipped', reason: 'not_enough_messages' };
  }

  const split = splitCompactPath({
    path,
    boundaryMessageId,
  });
  if (split === undefined || split.prefix.length === 0) {
    return { status: 'skipped', reason: 'empty_prefix' };
  }

  const controller = new AbortController();
  contextCompactRuntime.setActiveContextCompaction({
    chatId: mutableChat.id,
    controller,
  });
  chatRuntimeStore.startTask({ key: { kind: 'process', chatId: mutableChat.id } });
  registerLiveInstance({ chat: mutableChat });
  contextCompactRuntime.setProgress({
    chatId: mutableChat.id,
    progress: {
      phase: 'preparing',
      compactedMessageCount: split.prefix.length,
      suffixMessageCount: split.suffix.length,
    },
  });

  try {
    const { settings } = useSettings();
    const { addErrorEvent } = useGlobalEvents();
    const { getNaidanSysfsMountSelection } = useChatWeshPreferences();
    const loadedChat = getReadonlyChat({ chatId: mutableChat.id }) ?? mutableChat;
    const resolved = resolveChatSettings({
      chat: loadedChat,
      groups: collectChatGroups({ items: rootItems.value }),
      globalSettings: settings.value,
    });
    const resolvedModel = mutableChat.modelId || resolved.modelId;

    if (!resolvedModel || (!resolved.endpointUrl && resolved.endpointType !== 'transformers_js')) {
      addErrorEvent({
        source: 'useChat:compactCurrentBranch',
        message: 'Compact Context requires a configured model and endpoint.',
      });
      contextCompactRuntime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'failed',
          message: 'Compact Context requires a configured model and endpoint.',
        },
      });
      return { status: 'skipped', reason: 'missing_model_or_endpoint' };
    }

    const promptMode = resolveCompactPromptMode({
      mountSelection: getNaidanSysfsMountSelection({ chatId: mutableChat.id }),
    });
    contextCompactRuntime.setProgress({
      chatId: mutableChat.id,
      progress: {
        phase: 'building_request',
        compactedMessageCount: split.prefix.length,
        suffixMessageCount: split.suffix.length,
        requestPreview: undefined,
      },
    });

    const prefixMessages = await createCompactChatMessagesFromPrefix({
      prefix: split.prefix,
      promptMode,
    });
    const requestMessages = buildCompactRequestMessages({
      prefix: prefixMessages,
      promptMode,
      instructionContent: instructionOverride,
    });
    const requestPreview = createCompactRequestPreview({
      messages: requestMessages,
    });
    const provider = await createProviderForCompact({
      endpointType: resolved.endpointType,
      endpointUrl: resolved.endpointUrl,
      endpointHttpHeaders: resolved.endpointHttpHeaders,
    });

    let compactContent = '';
    contextCompactRuntime.setProgress({
      chatId: mutableChat.id,
      progress: {
        phase: 'requesting_model',
        compactedMessageCount: split.prefix.length,
        suffixMessageCount: split.suffix.length,
        requestPreview,
      },
    });

    await provider.chat({
      messages: requestMessages,
      model: resolvedModel,
      onChunk: (chunk) => {
        compactContent += chunk;
        contextCompactRuntime.setProgress({
          chatId: mutableChat.id,
          progress: {
            phase: 'receiving_compact',
            compactedMessageCount: split.prefix.length,
            suffixMessageCount: split.suffix.length,
            outputChars: compactContent.length,
            requestPreview,
            outputPreview: compactContent,
          },
        });
      },
      parameters: resolved.lmParameters,
      signal: controller.signal,
    });

    const finalCompactContent = compactContent.trim();
    if (finalCompactContent.length === 0) {
      contextCompactRuntime.setProgress({
        chatId: mutableChat.id,
        progress: {
          phase: 'failed',
          message: 'Compact Context response was empty.',
        },
      });
      return { status: 'skipped', reason: 'empty_response' };
    }

    contextCompactRuntime.setProgress({
      chatId: mutableChat.id,
      progress: {
        phase: 'applying_branch',
        outputChars: finalCompactContent.length,
        requestPreview,
        outputPreview: finalCompactContent,
      },
    });

    const branchResult = createCompactBranchFromResponse({
      compactContent: finalCompactContent,
      suffix: split.suffix,
      compactModelId: resolvedModel,
      createMessageId: () => generateId(),
      now: () => Date.now(),
    });

    mutableChat.root.items.push(branchResult.compactNode);
    mutableChat.currentLeafId = branchResult.currentLeafId;
    mutableChat.updatedAt = Date.now();

    await updateChatContent({
      id: mutableChat.id,
      updater: (current) => ({
        ...current,
        root: mutableChat.root,
        currentLeafId: mutableChat.currentLeafId,
      }),
    });
    await updateChatMeta({
      id: mutableChat.id,
      updater: (current) => {
        if (current === null) {
          return mutableChat;
        }

        return {
          ...current,
          updatedAt: mutableChat.updatedAt,
          currentLeafId: mutableChat.currentLeafId,
        };
      },
    });
    notifyChatChanged({ chatId: mutableChat.id });

    contextCompactRuntime.setProgress({
      chatId: mutableChat.id,
      progress: {
        phase: 'complete',
        requestPreview,
        outputPreview: finalCompactContent,
      },
    });

    return {
      status: 'compacted',
      chatId: mutableChat.id,
      compactNodeId: branchResult.compactNode.id,
      currentLeafId: branchResult.currentLeafId,
    };
  } catch (error) {
    if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Generation aborted')) {
      contextCompactRuntime.setProgress({
        chatId: mutableChat.id,
        progress: { phase: 'aborted' },
      });
      return { status: 'aborted' };
    }

    contextCompactRuntime.setProgress({
      chatId: mutableChat.id,
      progress: {
        phase: 'failed',
        message: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  } finally {
    contextCompactRuntime.clearActiveContextCompaction({
      chatId: mutableChat.id,
      controller,
    });
    chatRuntimeStore.finishTask({ key: { kind: 'process', chatId: mutableChat.id } });
  }
}

export function abortContextCompactForChat({
  chatId,
}: {
  chatId: string | undefined;
}): void {
  if (chatId === undefined) {
    return;
  }

  contextCompactRuntime.getActiveContextCompaction({ chatId })?.abort();
}

function resolveCompactPromptMode({
  mountSelection,
}: {
  mountSelection: ReturnType<ReturnType<typeof useChatWeshPreferences>['getNaidanSysfsMountSelection']>;
}): ContextCompactPromptMode {
  switch (mountSelection) {
  case 'none':
    return 'without_message_ids';
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'all_chats':
    return 'with_message_ids';
  default: {
    const _ex: never = mountSelection;
    throw new Error(`Unhandled naidan sysfs mount selection: ${_ex}`);
  }
  }
}

function collectChatGroups({
  items,
}: {
  items: SidebarItem[];
}): ChatGroup[] {
  const groups: ChatGroup[] = [];

  for (const item of items) {
    switch (item.type) {
    case 'chat':
      break;
    case 'chat_group':
      groups.push(item.chatGroup);
      break;
    default: {
      const _ex: never = item;
      return _ex;
    }
    }
  }

  return groups;
}
