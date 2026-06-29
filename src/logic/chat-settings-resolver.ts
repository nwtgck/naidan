import type { Chat, ChatGroup, Endpoint, LmParameters, Reasoning, SystemPrompt } from '@/01-models/types';
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
  titleModelId?: string,
  autoTitleEnabled?: boolean,
  systemPrompt?: string,
  lmParameters?: ResolvableLmParameters,
}


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

export function resolveChatSettings({ chat, groups, globalSettings }: { chat: Chat, groups: ChatGroup[], globalSettings: ResolvableSettings }) {

  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;

  const endpoint = chat.endpoint ?? group?.endpoint ?? globalSettings.endpoint;
  const modelId = chat.modelId || group?.modelId || globalSettings.defaultModelId || '';

  const autoTitleEnabled = chat.autoTitleEnabled !== undefined ? chat.autoTitleEnabled : (group?.autoTitleEnabled !== undefined ? group.autoTitleEnabled : globalSettings.autoTitleEnabled ?? true);
  const titleModelId = chat.titleModelId || group?.titleModelId || globalSettings.titleModelId || '';

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
    endpoint, modelId, autoTitleEnabled, titleModelId, systemPromptMessages: systemPrompts, lmParameters,
    sources: {
      endpoint: chat.endpoint !== undefined ? 'chat' : (group?.endpoint !== undefined ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (group?.modelId ? 'chat_group' : 'global'),
      autoTitleEnabled: chat.autoTitleEnabled !== undefined ? 'chat' : (group?.autoTitleEnabled !== undefined ? 'chat_group' : 'global'),
      titleModelId: chat.titleModelId ? 'chat' : (group?.titleModelId ? 'chat_group' : 'global'),
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
    autoTitleEnabled?: boolean,
    titleModelId?: string,
    systemPrompt?: SystemPrompt,
    lmParameters?: ResolvableLmParameters,
  },
}): boolean {
  return !!(
    chat.endpoint ||
    chat.modelId ||
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
    group.autoTitleEnabled !== undefined ||
    group.titleModelId ||
    group.systemPrompt ||
    (group.mounts && group.mounts.length > 0) ||
    hasLmParameterOverrides({ lmParameters: group.lmParameters })
  );
}
