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
  normalizeLmParameters,
  REASONING_PARAMETER_KEYS,
  type LmParameterOverrides,
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
  systemPrompt?: string,
  lmParameters?: ResolvableLmParameters,
}

export type ResolvedTitleGeneration =
  | 'disabled'
  | Readonly<{
      endpoint: Endpoint,
      modelId: string,
      lmParameters: LmParameters | undefined,
    }>;

type ResolvedNormalGeneration = Readonly<{
  endpoint: Endpoint,
  modelId: string,
  lmParameters: LmParameters | undefined,
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

function cloneResolvedLmParameters({
  lmParameters,
}: {
  lmParameters: LmParameterOverrides | undefined,
}): LmParameters | undefined {
  const normalized = normalizeLmParameters({ lmParameters });
  return normalized === undefined
    ? undefined
    : JSON.parse(JSON.stringify(normalized)) as LmParameters;
}

function resolveTitleLmParameters({
  titleGeneration,
  sameScope,
}: {
  titleGeneration: Exclude<SettingsTitleGeneration, 'disabled'>,
  sameScope: ResolvedNormalGeneration,
}): LmParameters | undefined {
  if (titleGeneration.lmParameters === 'same_scope') {
    return cloneResolvedLmParameters({ lmParameters: sameScope.lmParameters });
  }

  return cloneResolvedLmParameters({ lmParameters: titleGeneration.lmParameters });
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
  const lmParameters = resolveTitleLmParameters({ titleGeneration, sameScope });

  return { endpoint, modelId, lmParameters };
}

function resolveSettingsTitleGeneration({
  titleGeneration,
  sameScope,
}: {
  titleGeneration?: SettingsTitleGeneration,
  sameScope: ResolvedNormalGeneration,
}): ResolvedTitleGeneration {
  if (titleGeneration === 'disabled') return 'disabled';
  return resolveLocalTitleGeneration({
    titleGeneration: titleGeneration ?? { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS },
    sameScope,
  });
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

function hasLocalTitleGenerationOverride({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration | undefined,
}): boolean {
  return titleGeneration !== undefined && titleGeneration !== 'inherit';
}

function titleSource({
  chat,
  group,
}: {
  chat: Chat,
  group: ChatGroup | null | undefined,
}): 'chat' | 'chat_group' | 'global' {
  if (hasLocalTitleGenerationOverride({ titleGeneration: chat.titleGeneration })) return 'chat';
  if (hasLocalTitleGenerationOverride({ titleGeneration: group?.titleGeneration })) return 'chat_group';
  return 'global';
}

export function resolveChatSettings({ chat, groups, globalSettings }: { chat: Chat, groups: ChatGroup[], globalSettings: ResolvableSettings }) {

  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;

  const globalLmParameters: LmParameters = {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
  };
  applyLmParameterOverrides({ target: globalLmParameters, source: globalSettings.lmParameters });

  const groupLmParameters: LmParameters = {
    ...globalLmParameters,
    reasoning: { ...globalLmParameters.reasoning },
    stop: globalLmParameters.stop === undefined ? undefined : [...globalLmParameters.stop],
  };
  applyLmParameterOverrides({ target: groupLmParameters, source: group?.lmParameters });

  const chatLmParameters: LmParameters = {
    ...groupLmParameters,
    reasoning: { ...groupLmParameters.reasoning },
    stop: groupLmParameters.stop === undefined ? undefined : [...groupLmParameters.stop],
  };
  applyLmParameterOverrides({ target: chatLmParameters, source: chat.lmParameters });

  const globalGeneration: ResolvedNormalGeneration = {
    endpoint: globalSettings.endpoint,
    modelId: globalSettings.defaultModelId || '',
    lmParameters: globalLmParameters,
  };
  const groupGeneration: ResolvedNormalGeneration = {
    endpoint: group?.endpoint ?? globalGeneration.endpoint,
    modelId: group?.modelId || globalGeneration.modelId,
    lmParameters: groupLmParameters,
  };
  const chatGeneration: ResolvedNormalGeneration = {
    endpoint: chat.endpoint ?? groupGeneration.endpoint,
    modelId: chat.modelId || groupGeneration.modelId,
    lmParameters: chatLmParameters,
  };

  const globalTitleGeneration = resolveSettingsTitleGeneration({
    titleGeneration: globalSettings.titleGeneration ?? { endpoint: 'same_scope', model: 'same_scope', lmParameters: EMPTY_LM_PARAMETERS },
    sameScope: globalGeneration,
  });
  const groupTitleGeneration = group === null || group === undefined
    ? globalTitleGeneration
    : resolveScopedTitleGeneration({
      titleGeneration: group.titleGeneration ?? 'inherit',
      parent: globalTitleGeneration,
      sameScope: groupGeneration,
    });
  const chatTitleGeneration = resolveScopedTitleGeneration({
    titleGeneration: chat.titleGeneration ?? 'inherit',
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

  return {
    endpoint: chatGeneration.endpoint,
    modelId: chatGeneration.modelId,
    autoTitleEnabled: chatTitleGeneration !== 'disabled',
    titleGeneration: chatTitleGeneration,
    systemPromptMessages: systemPrompts,
    lmParameters: chatLmParameters,
    sources: {
      endpoint: chat.endpoint !== undefined ? 'chat' : (group?.endpoint !== undefined ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (group?.modelId ? 'chat_group' : 'global'),
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
    systemPrompt?: SystemPrompt,
    lmParameters?: ResolvableLmParameters,
  },
}): boolean {
  return !!(
    chat.endpoint ||
    chat.modelId ||
    hasLocalTitleGenerationOverride({ titleGeneration: chat.titleGeneration }) ||
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
    systemPrompt?: SystemPrompt,
    lmParameters?: ResolvableLmParameters,
    mounts?: readonly { type: string }[],
  },
}): boolean {
  return !!(
    group.endpoint ||
    group.modelId ||
    hasLocalTitleGenerationOverride({ titleGeneration: group.titleGeneration }) ||
    group.systemPrompt ||
    (group.mounts && group.mounts.length > 0) ||
    hasLmParameterOverrides({ lmParameters: group.lmParameters })
  );
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
