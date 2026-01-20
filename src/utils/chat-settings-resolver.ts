import type { Chat, ChatGroup, Settings } from '../models/types';

export function resolveChatSettings(chat: Chat, groups: ChatGroup[], globalSettings: Settings) {
  const group = chat.groupId ? groups.find(g => g.id === chat.groupId) : null;
  const endpointType = chat.endpointType || group?.endpoint?.type || globalSettings.endpointType;
  const endpointUrl = chat.endpointUrl || group?.endpoint?.url || globalSettings.endpointUrl || '';
  const endpointHttpHeaders = chat.endpointHttpHeaders || group?.endpoint?.httpHeaders || globalSettings.endpointHttpHeaders;
  const modelId = chat.modelId || group?.modelId || globalSettings.defaultModelId || '';

  let systemPrompts: string[] = [];
  if (globalSettings.systemPrompt) systemPrompts.push(globalSettings.systemPrompt);
  if (group?.systemPrompt) {
    if (group.systemPrompt.behavior === 'override') systemPrompts = group.systemPrompt.content ? [group.systemPrompt.content] : [];
    else if (group.systemPrompt.content) systemPrompts.push(group.systemPrompt.content);
  }
  if (chat.systemPrompt) {
    if (chat.systemPrompt.behavior === 'override') systemPrompts = chat.systemPrompt.content ? [chat.systemPrompt.content] : [];
    else if (chat.systemPrompt.content) systemPrompts.push(chat.systemPrompt.content);
  }

  const lmParameters = { ...(globalSettings.lmParameters || {}), ...(group?.lmParameters || {}), ...(chat.lmParameters || {}), };

  return {
    endpointType, endpointUrl, endpointHttpHeaders, modelId, systemPromptMessages: systemPrompts, lmParameters,
    sources: {
      endpointType: chat.endpointType ? 'chat' : (group?.endpoint?.type ? 'chat_group' : 'global'),
      endpointUrl: chat.endpointUrl ? 'chat' : (group?.endpoint?.url ? 'chat_group' : 'global'),
      modelId: chat.modelId ? 'chat' : (group?.modelId ? 'chat_group' : 'global'),
    } as const,
  };
}
