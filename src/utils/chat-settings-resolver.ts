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