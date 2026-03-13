import type { Chat, ChatGroup, EndpointType, LmParameters, Reasoning, SystemPrompt } from '@/models/types';
import { EMPTY_LM_PARAMETERS } from '@/models/types';

export interface ResolvableLmParameters {
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: readonly string[];
  reasoning: Reasoning;
}

export interface ResolvableSettings {
  endpointType: EndpointType;
  endpointUrl?: string;
  endpointHttpHeaders?: readonly (readonly [string, string])[];
  defaultModelId?: string;
  titleModelId?: string;
  autoTitleEnabled?: boolean;
  systemPrompt?: string;
  lmParameters?: ResolvableLmParameters;
}

export function resolveChatSettings(chat: Chat, groups: ChatGroup[], globalSettings: ResolvableSettings) {

  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;

  const endpointType = chat.endpointType || group?.endpoint?.type || globalSettings.endpointType;


  const endpointUrl = chat.endpointUrl || group?.endpoint?.url || globalSettings.endpointUrl || '';
  const endpointHttpHeaders = (chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || globalSettings.endpointHttpHeaders) as [string, string][] | undefined;
  const modelId = chat.modelId || group?.modelId || globalSettings.defaultModelId || '';

  const autoTitleEnabled = chat.autoTitleEnabled !== undefined ? chat.autoTitleEnabled : (group?.autoTitleEnabled !== undefined ? group.autoTitleEnabled : globalSettings.autoTitleEnabled ?? true);
  const titleModelId = chat.titleModelId || group?.titleModelId || globalSettings.titleModelId || '';

  let systemPrompts: string[] = [];
  if (globalSettings.systemPrompt) systemPrompts.push(globalSettings.systemPrompt);

  const groupSystemPrompt = group?.systemPrompt;
  if (groupSystemPrompt) {
    switch (groupSystemPrompt.behavior) {
    case 'override':
      systemPrompts = groupSystemPrompt.content ? [groupSystemPrompt.content] : [];
      break;
    case 'append':
      if (groupSystemPrompt.content) systemPrompts.push(groupSystemPrompt.content);
      break;
    default: {
      const _ex: never = groupSystemPrompt as never;
      throw new Error(`Unhandled system prompt behavior: ${(_ex as { behavior: string }).behavior}`);
    }
    }
  }

  const chatSystemPrompt = chat.systemPrompt;
  if (chatSystemPrompt) {
    switch (chatSystemPrompt.behavior) {
    case 'override':
      systemPrompts = chatSystemPrompt.content ? [chatSystemPrompt.content] : [];
      break;
    case 'append':
      if (chatSystemPrompt.content) systemPrompts.push(chatSystemPrompt.content);
      break;
    default: {
      const _ex: never = chatSystemPrompt as never;
      throw new Error(`Unhandled system prompt behavior: ${(_ex as { behavior: string }).behavior}`);
    }
    }
  }

  const lmParameters: LmParameters = {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning }
  };

  [globalSettings.lmParameters, group?.lmParameters, chat.lmParameters].forEach(src => {
    if (!src) return;
    const { reasoning, ...rest } = src;
    Object.assign(lmParameters, Object.fromEntries(Object.entries(rest).filter(([_, v]) => v !== undefined)));
    if (reasoning?.effort !== undefined) lmParameters.reasoning.effort = reasoning.effort;
  });

  return {
    endpointType, endpointUrl, endpointHttpHeaders, modelId, autoTitleEnabled, titleModelId, systemPromptMessages: systemPrompts, lmParameters,
    sources: {
      endpointType: chat.endpointType ? 'chat' : (group?.endpoint?.type ? 'chat_group' : 'global'),
      endpointUrl: chat.endpointUrl ? 'chat' : (group?.endpoint?.url ? 'chat_group' : 'global'),
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
    endpointType?: EndpointType;
    endpointUrl?: string;
    endpointHttpHeaders?: readonly (readonly [string, string])[];
    modelId?: string;
    autoTitleEnabled?: boolean;
    titleModelId?: string;
    systemPrompt?: SystemPrompt;
    lmParameters?: ResolvableLmParameters;
  }
}): boolean {
  return !!(
    chat.endpointType ||
    chat.endpointUrl ||
    (chat.endpointHttpHeaders && chat.endpointHttpHeaders.length > 0) ||
    chat.modelId ||
    chat.autoTitleEnabled !== undefined ||
    chat.titleModelId ||
    chat.systemPrompt ||
    (chat.lmParameters && (Object.keys(chat.lmParameters) as (keyof ResolvableLmParameters)[]).some(key => {
      switch (key) {
      case 'reasoning':
        return chat.lmParameters!.reasoning.effort !== undefined;
      case 'temperature':
      case 'topP':
      case 'maxCompletionTokens':
      case 'presencePenalty':
      case 'frequencyPenalty':
      case 'stop':
        return chat.lmParameters![key] !== undefined;
      default: {
        const _ex: never = key;
        throw new Error(`Unhandled parameter key: ${_ex}`);
      }
      }
    }))
  );
}

/**
 * Checks if a chat group has any specific setting overrides.
 */
export function hasGroupOverrides({ group }: {
  group: {
    endpoint?: {
      type: EndpointType;
      url?: string;
      httpHeaders?: readonly (readonly [string, string])[];
    };
    modelId?: string;
    autoTitleEnabled?: boolean;
    titleModelId?: string;
    systemPrompt?: SystemPrompt;
    lmParameters?: ResolvableLmParameters;
  }
}): boolean {
  return !!(
    group.endpoint ||
    group.modelId ||
    group.autoTitleEnabled !== undefined ||
    group.titleModelId ||
    group.systemPrompt ||
    (group.lmParameters && (Object.keys(group.lmParameters) as (keyof ResolvableLmParameters)[]).some(key => {
      switch (key) {
      case 'reasoning':
        return group.lmParameters!.reasoning.effort !== undefined;
      case 'temperature':
      case 'topP':
      case 'maxCompletionTokens':
      case 'presencePenalty':
      case 'frequencyPenalty':
      case 'stop':
        return group.lmParameters![key] !== undefined;
      default: {
        const _ex: never = key;
        throw new Error(`Unhandled parameter key: ${_ex}`);
      }
      }
    }))
  );
}