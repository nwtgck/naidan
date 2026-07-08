import type {
  Chat,
  ChatGroup,
  Endpoint,
  LmParameters,
  Reasoning,
  ScopedTitleGeneration,
  SettingsTitleGeneration,
  SystemPrompt,
} from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import {
  hasLmParameterOverrides,
  LM_PARAMETER_KEYS,
  REASONING_PARAMETER_KEYS,
} from '@/utils/lm-parameters';

export type ResolvableLmParameters = Readonly<
  Partial<Omit<LmParameters, 'reasoning' | 'stop'>>
> & Readonly<{
  stop?: readonly string[],
  reasoning: Reasoning,
}>;

export interface ResolvableSettings {
  endpoint: Endpoint,
  defaultModelId?: string,
  titleGeneration?: SettingsTitleGeneration,
  titleModelId?: string,
  autoTitleEnabled?: boolean,
  systemPrompt?: string,
  lmParameters?: ResolvableLmParameters,
}

export type ResolvedTitleGeneration =
  | 'disabled'
  | Readonly<{
      endpoint: Endpoint,
      modelId: string,
    }>;

type ResolvedNormalGeneration = Readonly<{
  endpoint: Endpoint,
  modelId: string,
}>;

function applyLmParameterOverrides({
  target,
  source,
}: {
  target: LmParameters,
  source: ResolvableLmParameters | LmParameters | undefined,
}): void {
  if (source === undefined) return;

  // Keep resolution keyed by the canonical domain shape. New top-level or
  // reasoning parameters must fail typechecking until their inheritance rules
  // are implemented instead of being silently dropped during resolution.
  for (const key of LM_PARAMETER_KEYS) {
    switch (key) {
    case 'temperature':
      if (source.temperature !== undefined) target.temperature = source.temperature;
      break;
    case 'topP':
      if (source.topP !== undefined) target.topP = source.topP;
      break;
    case 'maxCompletionTokens':
      if (source.maxCompletionTokens !== undefined) {
        target.maxCompletionTokens = source.maxCompletionTokens;
      }
      break;
    case 'presencePenalty':
      if (source.presencePenalty !== undefined) target.presencePenalty = source.presencePenalty;
      break;
    case 'frequencyPenalty':
      if (source.frequencyPenalty !== undefined) target.frequencyPenalty = source.frequencyPenalty;
      break;
    case 'stop':
      if (source.stop !== undefined) target.stop = [...source.stop];
      break;
    case 'reasoning':
      for (const reasoningKey of REASONING_PARAMETER_KEYS) {
        switch (reasoningKey) {
        case 'effort':
          if (source.reasoning?.effort !== undefined) {
            target.reasoning.effort = source.reasoning.effort;
          }
          break;
        default: {
          const _ex: never = reasoningKey;
          throw new Error(`Unhandled reasoning parameter key: ${_ex}`);
        }
        }
      }
      break;
    default: {
      const _ex: never = key;
      throw new Error(`Unhandled LM parameter key: ${_ex}`);
    }
    }
  }
}

function settingsTitleGenerationFromLegacy({
  autoTitleEnabled,
  titleModelId,
}: {
  autoTitleEnabled: boolean | undefined,
  titleModelId: string | undefined,
}): SettingsTitleGeneration {
  if (autoTitleEnabled === false) return 'disabled';

  return {
    endpoint: 'same_scope',
    model: titleModelId === undefined ? 'same_scope' : { id: titleModelId },
  };
}

function scopedTitleGenerationFromLegacy({
  autoTitleEnabled,
  titleModelId,
}: {
  autoTitleEnabled: boolean | undefined,
  titleModelId: string | undefined,
}): ScopedTitleGeneration {
  if (autoTitleEnabled === false) return 'disabled';
  if (autoTitleEnabled === undefined && titleModelId === undefined) return 'inherit';

  return {
    endpoint: 'same_scope',
    model: titleModelId === undefined ? 'same_scope' : { id: titleModelId },
  };
}

function resolveLocalTitleGeneration({
  titleGeneration,
  sameScope,
}: {
  titleGeneration: Exclude<SettingsTitleGeneration, 'disabled'>,
  sameScope: ResolvedNormalGeneration,
}): ResolvedTitleGeneration {
  const endpoint = titleGeneration.endpoint === 'same_scope'
    ? sameScope.endpoint
    : titleGeneration.endpoint;
  const modelId = titleGeneration.model === 'same_scope'
    ? sameScope.modelId
    : titleGeneration.model.id;

  return { endpoint, modelId };
}

function resolveSettingsTitleGeneration({
  titleGeneration,
  sameScope,
}: {
  titleGeneration: SettingsTitleGeneration,
  sameScope: ResolvedNormalGeneration,
}): ResolvedTitleGeneration {
  if (titleGeneration === 'disabled') return 'disabled';
  return resolveLocalTitleGeneration({ titleGeneration, sameScope });
}

function resolveScopedTitleGeneration({
  titleGeneration,
  parent,
  sameScope,
}: {
  titleGeneration: ScopedTitleGeneration,
  parent: ResolvedTitleGeneration,
  sameScope: ResolvedNormalGeneration,
}): ResolvedTitleGeneration {
  switch (titleGeneration) {
  case 'inherit':
    return parent;
  case 'disabled':
    return 'disabled';
  default:
    return resolveLocalTitleGeneration({ titleGeneration, sameScope });
  }
}

function titleModelIdFromResolvedTitleGeneration({
  titleGeneration,
}: {
  titleGeneration: ResolvedTitleGeneration,
}): string {
  return titleGeneration === 'disabled' ? '' : titleGeneration.modelId;
}

function titleSource({
  chat,
  group,
}: {
  chat: Chat,
  group: ChatGroup | null | undefined,
}): 'chat' | 'chat_group' | 'global' {
  if (chat.titleGeneration !== undefined || chat.autoTitleEnabled !== undefined || chat.titleModelId !== undefined) return 'chat';
  if (group?.titleGeneration !== undefined || group?.autoTitleEnabled !== undefined || group?.titleModelId !== undefined) return 'chat_group';
  return 'global';
}

export function resolveChatSettings({ chat, groups, globalSettings }: { chat: Chat, groups: ChatGroup[], globalSettings: ResolvableSettings }) {

  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;

  const globalGeneration: ResolvedNormalGeneration = {
    endpoint: globalSettings.endpoint,
    modelId: globalSettings.defaultModelId || '',
  };
  const groupGeneration: ResolvedNormalGeneration = {
    endpoint: group?.endpoint ?? globalGeneration.endpoint,
    modelId: group?.modelId || globalGeneration.modelId,
  };
  const chatGeneration: ResolvedNormalGeneration = {
    endpoint: chat.endpoint ?? groupGeneration.endpoint,
    modelId: chat.modelId || groupGeneration.modelId,
  };

  const globalTitleGeneration = resolveSettingsTitleGeneration({
    titleGeneration: globalSettings.titleGeneration ?? settingsTitleGenerationFromLegacy({
      autoTitleEnabled: globalSettings.autoTitleEnabled,
      titleModelId: globalSettings.titleModelId,
    }),
    sameScope: globalGeneration,
  });
  const groupTitleGeneration = group === null || group === undefined
    ? globalTitleGeneration
    : resolveScopedTitleGeneration({
      titleGeneration: group.titleGeneration ?? scopedTitleGenerationFromLegacy({
        autoTitleEnabled: group.autoTitleEnabled,
        titleModelId: group.titleModelId,
      }),
      parent: globalTitleGeneration,
      sameScope: groupGeneration,
    });
  const chatTitleGeneration = resolveScopedTitleGeneration({
    titleGeneration: chat.titleGeneration ?? scopedTitleGenerationFromLegacy({
      autoTitleEnabled: chat.autoTitleEnabled,
      titleModelId: chat.titleModelId,
    }),
    parent: groupTitleGeneration,
    sameScope: chatGeneration,
  });

  let systemPrompts: string[] = [];
  if (globalSettings.systemPrompt) systemPrompts.push(globalSettings.systemPrompt);

  const groupSystemPrompt = group?.systemPrompt;
  if (groupSystemPrompt) {
    // Keep the union exhaustive so a new composition behavior cannot be
    // silently ignored while resolving inherited prompts.
    switch (groupSystemPrompt.behavior) {
    case 'override':
      systemPrompts = groupSystemPrompt.content ? [groupSystemPrompt.content] : [];
      break;
    case 'append':
      if (groupSystemPrompt.content) systemPrompts.push(groupSystemPrompt.content);
      break;
    default: {
      const _ex: never = groupSystemPrompt;
      throw new Error(`Unhandled group system prompt: ${String(_ex)}`);
    }
    }
  }

  const chatSystemPrompt = chat.systemPrompt;
  if (chatSystemPrompt) {
    // Mirror the group-level exhaustive check. Both scope layers must be
    // reviewed when the SystemPrompt union gains a new behavior.
    switch (chatSystemPrompt.behavior) {
    case 'override':
      systemPrompts = chatSystemPrompt.content ? [chatSystemPrompt.content] : [];
      break;
    case 'append':
      if (chatSystemPrompt.content) systemPrompts.push(chatSystemPrompt.content);
      break;
    default: {
      const _ex: never = chatSystemPrompt;
      throw new Error(`Unhandled chat system prompt: ${String(_ex)}`);
    }
    }
  }

  const lmParameters: LmParameters = {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
  };

  for (const source of [globalSettings.lmParameters, group?.lmParameters, chat.lmParameters]) {
    applyLmParameterOverrides({ target: lmParameters, source });
  }

  return {
    endpoint: chatGeneration.endpoint,
    modelId: chatGeneration.modelId,
    autoTitleEnabled: chatTitleGeneration !== 'disabled',
    titleModelId: titleModelIdFromResolvedTitleGeneration({ titleGeneration: chatTitleGeneration }),
    titleGeneration: chatTitleGeneration,
    systemPromptMessages: systemPrompts,
    lmParameters,
    sources: {
      endpoint: chat.endpoint !== undefined ? 'chat' : (group?.endpoint !== undefined ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (group?.modelId ? 'chat_group' : 'global'),
      autoTitleEnabled: titleSource({ chat, group }),
      titleModelId: titleSource({ chat, group }),
      titleGeneration: titleSource({ chat, group }),
    } as const,
  };
}

/**
 * Checks if a chat has any specific setting overrides.
 */
export function hasChatOverrides({ chat }: {
  chat: {
    endpoint?: Endpoint,
    modelId?: string,
    titleGeneration?: ScopedTitleGeneration,
    autoTitleEnabled?: boolean,
    titleModelId?: string,
    systemPrompt?: SystemPrompt,
    lmParameters?: ResolvableLmParameters,
  },
}): boolean {
  return !!(
    chat.endpoint ||
    chat.modelId ||
    chat.titleGeneration !== undefined ||
    chat.autoTitleEnabled !== undefined ||
    chat.titleModelId ||
    chat.systemPrompt ||
    hasLmParameterOverrides({ lmParameters: chat.lmParameters })
  );
}

/**
 * Checks if a chat group has any specific setting overrides.
 */
export function hasGroupOverrides({ group }: {
  group: {
    endpoint?: Endpoint,
    modelId?: string,
    titleGeneration?: ScopedTitleGeneration,
    autoTitleEnabled?: boolean,
    titleModelId?: string,
    systemPrompt?: SystemPrompt,
    lmParameters?: ResolvableLmParameters,
    mounts?: readonly { type: string }[],
  },
}): boolean {
  return !!(
    group.endpoint ||
    group.modelId ||
    group.titleGeneration !== undefined ||
    group.autoTitleEnabled !== undefined ||
    group.titleModelId ||
    group.systemPrompt ||
    (group.mounts && group.mounts.length > 0) ||
    hasLmParameterOverrides({ lmParameters: group.lmParameters })
  );
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
