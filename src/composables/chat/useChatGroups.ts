import type { ScopedSettingChange } from '@/01-models/scoped-setting-change';
import type { ChatGroup } from '@/01-models/types';
import type { ToolConfig } from '@/01-models/tool';
import { storageService } from '@/00-storage/service';
import {
  currentChatGroupRef,
  currentChatRef,
  loadData,
} from '@/composables/chat/global/chat-core-singletons';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import {
  applyScopedSettingChangesToChatGroup,
  cloneScopedSettingChanges,
  createLmParameterSettingChanges,
  createSystemPromptSettingChange,
} from '@/logic/scoped-setting-changes';
import { cloneToolConfigs } from '@/features/tools/tool-config';

type ChatGroupMetadataUpdate = Partial<Pick<
  ChatGroup,
  | 'name'
  | 'endpoint'
  | 'modelId'
  | 'autoTitleEnabled'
  | 'titleModelId'
  | 'systemPrompt'
  | 'lmParameters'
>>;

const chatGroupMetadataUpdateKeyRecord: Readonly<Record<keyof ChatGroupMetadataUpdate, true>> = {
  name: true,
  endpoint: true,
  modelId: true,
  autoTitleEnabled: true,
  titleModelId: true,
  systemPrompt: true,
  lmParameters: true,
};

const CHAT_GROUP_METADATA_UPDATE_KEYS = Object.keys(
  chatGroupMetadataUpdateKeyRecord,
) as (keyof ChatGroupMetadataUpdate)[];

const updateQueues = new Map<ChatGroupId, Promise<void>>();

export type ToolConfigsUpdater = ({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined,
}) => ToolConfig[] | undefined;

type ChatGroupToolConfigUpdate =
  | { behavior: 'preserve' }
  | { behavior: 'update', updater: ToolConfigsUpdater };

function legacyUpdatesToChanges({
  updates,
}: {
  updates: ChatGroupMetadataUpdate,
}): ScopedSettingChange[] {
  const changes: ScopedSettingChange[] = [];

  // Keep this adapter exhaustive so extending ChatGroupMetadataUpdate cannot
  // silently bypass the explicit scoped-setting command model. `name` remains
  // a non-inheritable metadata update and is handled by updateChatGroup().
  for (const key of CHAT_GROUP_METADATA_UPDATE_KEYS) {
    if (!Object.hasOwn(updates, key)) continue;

    switch (key) {
    case 'name':
      break;
    case 'endpoint':
      changes.push(updates.endpoint === undefined
        ? { field: 'endpoint', behavior: 'inherit' }
        : { field: 'endpoint', behavior: 'override', value: updates.endpoint });
      break;
    case 'modelId':
      changes.push(updates.modelId === undefined
        ? { field: 'model_id', behavior: 'inherit' }
        : { field: 'model_id', behavior: 'override', value: updates.modelId });
      break;
    case 'autoTitleEnabled':
      changes.push(updates.autoTitleEnabled === undefined
        ? { field: 'auto_title_enabled', behavior: 'inherit' }
        : { field: 'auto_title_enabled', behavior: 'override', value: updates.autoTitleEnabled });
      break;
    case 'titleModelId':
      changes.push(updates.titleModelId === undefined
        ? { field: 'title_model_id', behavior: 'inherit' }
        : { field: 'title_model_id', behavior: 'override', value: updates.titleModelId });
      break;
    case 'systemPrompt':
      changes.push(createSystemPromptSettingChange({ systemPrompt: updates.systemPrompt }));
      break;
    case 'lmParameters':
      changes.push(...createLmParameterSettingChanges({ lmParameters: updates.lmParameters }));
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled chat group metadata update key: ${_ex}`);
    }
    }
  }

  return changes;
}


export type ChatGroupsAdapter = {
  updateChatGroupMetadata({
    chatGroupId,
    updates,
  }: {
    chatGroupId: ChatGroupId,
    updates: ChatGroupMetadataUpdate,
  }): Promise<void>,

  updateScopedSettings({
    chatGroupId,
    changes,
  }: {
    chatGroupId: ChatGroupId,
    changes: readonly ScopedSettingChange[],
  }): Promise<void>,

  updateToolConfigs({
    chatGroupId,
    updater,
  }: {
    chatGroupId: ChatGroupId,
    updater: ToolConfigsUpdater,
  }): Promise<void>,

  updateScopedSettingsAndToolConfigs({
    chatGroupId,
    changes,
    updater,
  }: {
    chatGroupId: ChatGroupId,
    changes: readonly ScopedSettingChange[],
    updater: ToolConfigsUpdater,
  }): Promise<void>,

  moveChatToGroup({
    chatId,
    chatGroupId,
  }: {
    chatId: ChatId,
    chatGroupId: ChatGroupId | undefined,
  }): Promise<void>,

  TEST_ONLY: Record<never, never>,
};

export function useChatGroups(): ChatGroupsAdapter {
  async function updateChatGroup({
    chatGroupId,
    changes,
    name,
    updateName,
    toolConfigUpdate,
  }: {
    chatGroupId: ChatGroupId,
    changes: readonly ScopedSettingChange[],
    name: string | undefined,
    updateName: boolean,
    toolConfigUpdate: ChatGroupToolConfigUpdate,
  }): Promise<void> {
    const hasToolConfigUpdate = (() => {
      switch (toolConfigUpdate.behavior) {
      case 'preserve':
        return false;
      case 'update':
        return true;
      default: {
        const _ex: never = toolConfigUpdate;
        throw new Error(`Unhandled Chat Group tool config update: ${String(_ex)}`);
      }
      }
    })();
    if (changes.length === 0 && !updateName && !hasToolConfigUpdate) return;

    const queuedChanges = cloneScopedSettingChanges({ changes });
    const previous = updateQueues.get(chatGroupId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        let savedChatGroup: ChatGroup | undefined;
        await storageService.updateChatGroup({
          id: chatGroupId,
          updater: ({ current }) => {
            if (current === null) {
              throw new Error('Chat group not found');
            }

            // Use the latest persisted timestamp while holding the storage
            // lock so queued updates and clock skew cannot move it backwards.
            const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
            const updated = applyScopedSettingChangesToChatGroup({
              current,
              changes: queuedChanges,
              updatedAt,
            });
            const nextToolConfigs = (() => {
              switch (toolConfigUpdate.behavior) {
              case 'preserve':
                return current.toolConfigs;
              case 'update':
                return cloneToolConfigs({
                  toolConfigs: toolConfigUpdate.updater({
                    toolConfigs: cloneToolConfigs({ toolConfigs: current.toolConfigs }),
                  }),
                });
              default: {
                const _ex: never = toolConfigUpdate;
                throw new Error(`Unhandled Chat Group tool config update: ${String(_ex)}`);
              }
              }
            })();
            savedChatGroup = {
              ...updated,
              ...(updateName && name !== undefined ? { name } : {}),
              ...(hasToolConfigUpdate ? { toolConfigs: nextToolConfigs } : {}),
              updatedAt,
            };
            return savedChatGroup;
          },
        });
        await loadData();

        // loadData refreshes sidebar state, while the settings panel reads this
        // dedicated ref. Keep both views on the same successfully persisted value.
        if (
          savedChatGroup !== undefined
          && currentChatGroupRef.value?.id === chatGroupId
          && currentChatGroupRef.value.updatedAt <= savedChatGroup.updatedAt
        ) {
          currentChatGroupRef.value = savedChatGroup;
        }
      });

    const queueTail = operation.then(
      () => undefined,
      () => undefined,
    );
    updateQueues.set(chatGroupId, queueTail);

    try {
      await operation;
    } finally {
      if (updateQueues.get(chatGroupId) === queueTail) {
        updateQueues.delete(chatGroupId);
      }
    }
  }

  async function updateScopedSettings({
    chatGroupId,
    changes,
  }: {
    chatGroupId: ChatGroupId,
    changes: readonly ScopedSettingChange[],
  }): Promise<void> {
    await updateChatGroup({
      chatGroupId,
      changes,
      name: undefined,
      updateName: false,
      toolConfigUpdate: { behavior: 'preserve' },
    });
  }

  async function updateToolConfigs({
    chatGroupId,
    updater,
  }: {
    chatGroupId: ChatGroupId,
    updater: ToolConfigsUpdater,
  }): Promise<void> {
    await updateChatGroup({
      chatGroupId,
      changes: [],
      name: undefined,
      updateName: false,
      toolConfigUpdate: { behavior: 'update', updater },
    });
  }

  async function updateScopedSettingsAndToolConfigs({
    chatGroupId,
    changes,
    updater,
  }: {
    chatGroupId: ChatGroupId,
    changes: readonly ScopedSettingChange[],
    updater: ToolConfigsUpdater,
  }): Promise<void> {
    await updateChatGroup({
      chatGroupId,
      changes,
      name: undefined,
      updateName: false,
      toolConfigUpdate: { behavior: 'update', updater },
    });
  }

  async function updateChatGroupMetadata({
    chatGroupId,
    updates,
  }: {
    chatGroupId: ChatGroupId,
    updates: ChatGroupMetadataUpdate,
  }): Promise<void> {
    await updateChatGroup({
      chatGroupId,
      changes: legacyUpdatesToChanges({ updates }),
      name: updates.name,
      updateName: Object.hasOwn(updates, 'name'),
      toolConfigUpdate: { behavior: 'preserve' },
    });
  }

  async function moveChatToGroup({
    chatId,
    chatGroupId,
  }: {
    chatId: ChatId,
    chatGroupId: ChatGroupId | undefined,
  }): Promise<void> {
    if (currentChatRef.value?.id === chatId) {
      currentChatRef.value.groupId = chatGroupId;
      currentChatRef.value.updatedAt = Date.now();
    }

    await storageService.updateHierarchy({ updater: ({ current }) => {
      let detachedChatId: ChatId | undefined;

      current.items = current.items.filter((item) => {
        switch (item.type) {
        case 'chat':
          if (item.id === chatId) {
            detachedChatId = item.id;
            return false;
          }
          return true;
        case 'chat_group': {
          const chatIndex = item.chat_ids.indexOf(chatId);
          if (chatIndex !== -1) {
            detachedChatId = item.chat_ids[chatIndex];
            item.chat_ids.splice(chatIndex, 1);
          }
          return true;
        }
        default: {
          const _ex: never = item;
          throw new Error(`Unhandled hierarchy node type: ${_ex}`);
        }
        }
      });

      if (detachedChatId === undefined) {
        detachedChatId = chatId;
      }

      if (chatGroupId === undefined) {
        current.items.unshift({ type: 'chat', id: detachedChatId });
        return current;
      }

      const groupNode = current.items.find((item) => item.type === 'chat_group' && item.id === chatGroupId);
      if (groupNode === undefined || groupNode.type !== 'chat_group') {
        throw new Error('Chat group not found in hierarchy');
      }
      groupNode.chat_ids.unshift(detachedChatId);
      return current;
    } });
    await loadData();
  }

  return {
    updateChatGroupMetadata,
    updateScopedSettings,
    updateToolConfigs,
    updateScopedSettingsAndToolConfigs,
    moveChatToGroup,
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {},
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
