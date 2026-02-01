import type { Chat, ChatGroup, EndpointType, LmParameters } from '../models/types';

export interface ResolvableLmParameters {
  temperature?: number;
  topP?: number;
  maxCompletionTokens?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: readonly string[];
}

export interface ResolvableSettings {
  endpointType: EndpointType;
  endpointUrl?: string;
  endpointHttpHeaders?: readonly (readonly [string, string])[];
  defaultModelId?: string;
  systemPrompt?: string;
  lmParameters?: ResolvableLmParameters;
}

export function resolveChatSettings(chat: Chat, groups: ChatGroup[], globalSettings: ResolvableSettings) {

  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;

  const endpointType = chat.endpointType || group?.endpoint?.type || globalSettings.endpointType;


  const endpointUrl = chat.endpointUrl || group?.endpoint?.url || globalSettings.endpointUrl || '';
  const endpointHttpHeaders = (chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || globalSettings.endpointHttpHeaders) as [string, string][] | undefined;
  const modelId = chat.modelId || group?.modelId || globalSettings.defaultModelId || '';

  let systemPrompts: string[] = [];
  if (globalSettings.systemPrompt) systemPrompts.push(globalSettings.systemPrompt);
  if (group?.systemPrompt) {
    switch (group.systemPrompt.behavior) {
    case 'override':
      systemPrompts = group.systemPrompt.content ? [group.systemPrompt.content] : [];
      break;
    case 'append':
      if (group.systemPrompt.content) systemPrompts.push(group.systemPrompt.content);
      break;
    default: {
      const _ex: never = group.systemPrompt.behavior;
      throw new Error(`Unhandled system prompt behavior: ${_ex}`);
    }
    }
  }
  if (chat.systemPrompt) {
    switch (chat.systemPrompt.behavior) {
    case 'override':
      systemPrompts = chat.systemPrompt.content ? [chat.systemPrompt.content] : [];
      break;
    case 'append':
      if (chat.systemPrompt.content) systemPrompts.push(chat.systemPrompt.content);
      break;
    default: {
      const _ex: never = chat.systemPrompt.behavior;
      throw new Error(`Unhandled system prompt behavior: ${_ex}`);
    }
    }
  }

  const lmParameters = { 
    ...(globalSettings.lmParameters || {}), 
    ...(group?.lmParameters || {}), 
    ...(chat.lmParameters || {}), 
  } as LmParameters;

  return {
    endpointType, endpointUrl, endpointHttpHeaders, modelId, systemPromptMessages: systemPrompts, lmParameters,
    sources: {
      endpointType: chat.endpointType ? 'chat' : (group?.endpoint?.type ? 'chat_group' : 'global'),
      endpointUrl: chat.endpointUrl ? 'chat' : (group?.endpoint?.url ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (group?.modelId ? 'chat_group' : 'global'),
    } as const,
  };
}