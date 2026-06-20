/**
 * Mappers
 */
import type { ToolConfig } from '@/services/tools/types';

import type {
  RoleDto,
  MessageNodeDto,
  ChatDto,
  ChatMetaDto,
  ChatGroupDto,
  SettingsDto,
  EndpointDto,
  StorageTypeDto,
  AttachmentDto,
  HierarchyDto,
  ChatContentDto,
  BinaryObjectDto,
  LmParametersDto,
  MountDto,
  VolumeDto,
} from './dto';
import type {
  Role,
  MessageNode,
  AssistantMessageNode,
  UserMessageNode,
  SystemMessageNode,
  MessageBranch,
  Chat,
  ChatGroup,
  ChatSummary,
  ChatSidebarItem,
  SidebarItem,
  Settings,
  EndpointType,
  Endpoint,
  StorageType,
  SystemPrompt,
  Attachment,
  ChatMeta,
  ChatContent,
  Hierarchy,
  HierarchyNode,
  HierarchyChatGroupNode,
  BinaryObject,
  LmParameters,
  Mount,
  Volume,
  ToolConfigPersistence,
} from './types';
import { EMPTY_LM_PARAMETERS } from './types';
import {
  idToRaw,
  toAttachmentId,
  toBinaryObjectId,
  toChatGroupId,
  toChatId,
  toMessageId,
  toProviderProfileId,
  toToolCallId,
  toVolumeId,
} from '@/models/ids';
import {
  LM_PARAMETER_KEYS,
  normalizeLmParameters,
  REASONING_PARAMETER_KEYS,
} from '@/utils/lm-parameters';


const toolConfigPersistenceToExperimentalDto = ({
  persistence,
}: {
  persistence: ToolConfigPersistence | undefined;
}): 'enabled' | undefined => {
  const normalized = persistence ?? 'disabled';
  switch (normalized) {
  case 'disabled':
    return undefined;
  case 'enabled':
    return 'enabled';
  default: {
    const _exhaustive: never = normalized;
    throw new Error(`Unhandled tool config persistence setting: ${String(_exhaustive)}`);
  }
  }
};

const fakeLmToExperimentalDto = ({
  status,
}: {
  status: 'disabled' | 'enabled' | undefined;
}): 'enabled' | undefined => {
  const normalized = status ?? 'disabled';
  switch (normalized) {
  case 'disabled':
    return undefined;
  case 'enabled':
    return 'enabled';
  default: {
    const _exhaustive: never = normalized;
    throw new Error(`Unhandled fake LM setting: ${String(_exhaustive)}`);
  }
  }
};

const toolConfigsToDomain = ({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined;
}): ToolConfig[] | undefined => toolConfigs;

const toolConfigsToExperimentalDto = ({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined;
}): { toolConfigs: ToolConfig[] | undefined } | undefined => {
  return toolConfigs === undefined ? undefined : { toolConfigs };
};

const mountToDomain = ({ dto }: { dto: MountDto }): Mount => {
  const type = dto.type;
  switch (type) {
  case 'volume':
    return { type: 'volume', volumeId: toVolumeId({ raw: dto.volumeId }), mountPath: dto.mountPath, readOnly: dto.readOnly };
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled mount type: ${_ex}`);
  }
  }
};

const mountToDto = ({ domain }: { domain: Mount }): MountDto => {
  const type = domain.type;
  switch (type) {
  case 'volume':
    return { type: 'volume', volumeId: idToRaw({ id: domain.volumeId }), mountPath: domain.mountPath, readOnly: domain.readOnly };
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled mount type: ${_ex}`);
  }
  }
};

export const roleToDomain = ({ dto }: { dto: RoleDto }): Role => {
  switch (dto) {
  case 'user': return 'user';
  case 'assistant': return 'assistant';
  case 'system': return 'system';
  case 'tool': return 'tool';
  default: throw new Error(`Unknown role: ${dto}`);
  }
};

/**
 * Hierarchy Mappers
 */
export const hierarchyToDomain = ({ dto }: { dto: HierarchyDto }): Hierarchy => ({
  items: dto.items.map(item => {
    switch (item.type) {
    case 'chat':
      return { type: 'chat', id: toChatId({ raw: item.id }) };
    case 'chat_group':
      return {
        type: 'chat_group',
        id: toChatGroupId({ raw: item.id }),
        chat_ids: item.chat_ids.map(raw => toChatId({ raw })),
      };
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled hierarchy item type: ${_ex}`);
    }
    }
  }),
});

export const hierarchyToDto = ({ domain }: { domain: Hierarchy }): HierarchyDto => ({
  items: domain.items.map(item => {
    switch (item.type) {
    case 'chat':
      return { type: 'chat', id: idToRaw({ id: item.id }) };
    case 'chat_group':
      return {
        type: 'chat_group',
        id: idToRaw({ id: item.id }),
        chat_ids: item.chat_ids.map(id => idToRaw({ id })),
      };
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled hierarchy item type: ${_ex}`);
    }
    }
  }),
});

export const chatMetaToDomain = ({ dto }: { dto: ChatMetaDto }): ChatMeta => ({
  id: toChatId({ raw: dto.id }),
  title: dto.title,
  createdAt: dto.createdAt,
  updatedAt: dto.updatedAt,
  debugEnabled: dto.debugEnabled,
  modelId: dto.modelId,
  endpoint: dto.endpoint ? (() => {
    const endpoint = dto.endpoint;
    switch (endpoint.type) {
    case 'openai':
    case 'ollama':
      return {
        type: endpoint.type as EndpointType,
        url: endpoint.url || undefined,
        httpHeaders: endpoint.httpHeaders,
      };
    case 'transformers_js':
      return {
        type: endpoint.type as EndpointType,
        url: undefined,
        httpHeaders: undefined,
      };
    default: {
      const _ex: never = endpoint;
      throw new Error(`Unhandled endpoint type: ${(_ex as { type: string }).type}`);
    }
    }
  })() : undefined,
  systemPrompt: dto.systemPrompt as SystemPrompt | undefined,
  lmParameters: lmParametersToDomain({ dto: dto.lmParameters }),
  autoTitleEnabled: dto.autoTitleEnabled,
  titleModelId: dto.titleModelId,
  currentLeafId: dto.currentLeafId === undefined ? undefined : toMessageId({ raw: dto.currentLeafId }),
  originChatId: dto.originChatId === undefined ? undefined : toChatId({ raw: dto.originChatId }),
  originMessageId: dto.originMessageId === undefined ? undefined : toMessageId({ raw: dto.originMessageId }),
  mounts: dto.mounts?.map(dto => mountToDomain({ dto })),
  toolConfigs: toolConfigsToDomain({ toolConfigs: dto.experimental?.toolConfigs as ToolConfig[] | undefined }),
});

/**
 * Converts a Chat Group DTO into a Domain ChatGroup.
 * Resolves nested items using the hierarchy and provided chat metadata.
 */
export const chatGroupToDomain = (
  { dto, hierarchy, chatMetas }: { dto: ChatGroupDto, hierarchy: Hierarchy, chatMetas: ChatMeta[] }
): ChatGroup => {
  const node = hierarchy.items.find(
    i => i.type === 'chat_group' && i.id === toChatGroupId({ raw: dto.id })
  ) as HierarchyChatGroupNode | undefined;

  const chatIds = node?.chat_ids || [];

  const items: ChatSidebarItem[] = chatIds.map(cid => {
    const meta = chatMetas.find(m => m.id === cid);
    return {
      id: `chat:${idToRaw({ id: cid })}`,
      type: 'chat',
      chat: {
        id: cid,
        title: meta?.title || null,
        updatedAt: meta?.updatedAt || 0,
        groupId: toChatGroupId({ raw: dto.id })
      }
    };
  });

  return {
    id: toChatGroupId({ raw: dto.id }),
    name: dto.name,
    isCollapsed: dto.isCollapsed,
    updatedAt: dto.updatedAt,
    items,
    endpoint: dto.endpoint ? (() => {
      const endpoint = dto.endpoint;
      switch (endpoint.type) {
      case 'openai':
      case 'ollama':
        return {
          type: endpoint.type as EndpointType,
          url: endpoint.url || undefined,
          httpHeaders: endpoint.httpHeaders,
        };
      case 'transformers_js':
        return {
          type: endpoint.type as EndpointType,
          url: undefined,
          httpHeaders: undefined,
        };
      default: {
        const _ex: never = endpoint;
        throw new Error(`Unhandled endpoint type: ${(_ex as { type: string }).type}`);
      }
      }
    })() : undefined,
    modelId: dto.modelId,
    autoTitleEnabled: dto.autoTitleEnabled,
    titleModelId: dto.titleModelId,
    systemPrompt: dto.systemPrompt as SystemPrompt | undefined,
    lmParameters: lmParametersToDomain({ dto: dto.lmParameters }),
    mounts: dto.mounts?.map(dto => mountToDomain({ dto })),
  };
};

export const chatGroupToDto = ({ domain }: { domain: ChatGroup }): ChatGroupDto => ({
  id: idToRaw({ id: domain.id }),
  name: domain.name,
  isCollapsed: domain.isCollapsed,
  updatedAt: domain.updatedAt,
  endpoint: domain.endpoint ? endpointToDto({ endpoint: domain.endpoint }) : undefined,
  modelId: domain.modelId,
  autoTitleEnabled: domain.autoTitleEnabled,
  titleModelId: domain.titleModelId,
  systemPrompt: domain.systemPrompt,
  lmParameters: lmParametersToDto({ domain: domain.lmParameters }),
  mounts: domain.mounts?.map(domain => mountToDto({ domain })),
});

export const lmParametersToDomain = (
  { dto }: { dto: LmParametersDto | undefined }
): LmParameters | undefined => {
  if (!dto) return undefined;

  const lmParameters: LmParameters = {
    ...EMPTY_LM_PARAMETERS,
    reasoning: { ...EMPTY_LM_PARAMETERS.reasoning },
  };

  // Map from the canonical domain key set rather than a hand-maintained object.
  // Adding an LM or reasoning parameter must fail typechecking here until its
  // DTO conversion is reviewed, preventing persistence omissions in refactors.
  for (const key of LM_PARAMETER_KEYS) {
    switch (key) {
    case 'temperature':
      lmParameters.temperature = dto.temperature;
      break;
    case 'topP':
      lmParameters.topP = dto.topP;
      break;
    case 'maxCompletionTokens':
      lmParameters.maxCompletionTokens = dto.maxCompletionTokens;
      break;
    case 'presencePenalty':
      lmParameters.presencePenalty = dto.presencePenalty;
      break;
    case 'frequencyPenalty':
      lmParameters.frequencyPenalty = dto.frequencyPenalty;
      break;
    case 'stop':
      lmParameters.stop = dto.stop;
      break;
    case 'reasoning':
      for (const reasoningKey of REASONING_PARAMETER_KEYS) {
        switch (reasoningKey) {
        case 'effort':
          lmParameters.reasoning.effort = dto.reasoning?.effort;
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

  return normalizeLmParameters({ lmParameters });
};

export const lmParametersToDto = (
  { domain }: { domain: LmParameters | undefined }
): LmParametersDto | undefined => {
  const normalized = normalizeLmParameters({ lmParameters: domain });
  if (normalized === undefined) return undefined;

  const reasoningDto: NonNullable<LmParametersDto['reasoning']> = { effort: undefined };
  const dto: LmParametersDto = {
    temperature: undefined,
    topP: undefined,
    maxCompletionTokens: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
    stop: undefined,
    reasoning: reasoningDto,
  };

  // DTO fields are optional, so an object literal alone would not reveal a new
  // domain parameter that was forgotten here. Keep this exhaustive traversal as
  // a compile-time review gate for every persisted LM and reasoning parameter.
  for (const key of LM_PARAMETER_KEYS) {
    switch (key) {
    case 'temperature':
      dto.temperature = normalized.temperature;
      break;
    case 'topP':
      dto.topP = normalized.topP;
      break;
    case 'maxCompletionTokens':
      dto.maxCompletionTokens = normalized.maxCompletionTokens;
      break;
    case 'presencePenalty':
      dto.presencePenalty = normalized.presencePenalty;
      break;
    case 'frequencyPenalty':
      dto.frequencyPenalty = normalized.frequencyPenalty;
      break;
    case 'stop':
      dto.stop = normalized.stop;
      break;
    case 'reasoning':
      for (const reasoningKey of REASONING_PARAMETER_KEYS) {
        switch (reasoningKey) {
        case 'effort':
          reasoningDto.effort = normalized.reasoning.effort;
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

  return dto;
};

export const endpointToDto = ({ endpoint }: { endpoint: Endpoint }): EndpointDto => {
  const type = endpoint.type;
  switch (type) {
  case 'openai':
  case 'ollama':
    return {
      type: type,
      url: endpoint.url || '',
      httpHeaders: endpoint.httpHeaders,
    };
  case 'transformers_js':
    return {
      type: 'transformers_js',
    };
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled endpoint type: ${_ex}`);
  }
  }
};

const attachmentToDomain = ({ dto }: { dto: AttachmentDto }): Attachment => {
  if ('binaryObjectId' in dto) {
    // V2
    const base = {
      id: toAttachmentId({ raw: dto.id }),
      binaryObjectId: toBinaryObjectId({ raw: dto.binaryObjectId }),
      originalName: dto.name,
      // Metadata will be hydrated by the StorageProvider
      mimeType: 'application/octet-stream',
      size: 0,
      uploadedAt: Date.now(),
    };

    switch (dto.status) {
    case 'persisted': return { ...base, status: 'persisted' };
    case 'missing': return { ...base, status: 'missing' };
    case 'memory':
      return { ...base, status: 'memory' } as unknown as Attachment;
    default: {
      const _ex: never = dto.status;
      throw new Error(`Unhandled attachment status: ${_ex}`);
    }
    }
  } else {
    // V1 (Legacy)
    const base = {
      id: toAttachmentId({ raw: dto.id }),
      binaryObjectId: toBinaryObjectId({ raw: dto.id }), // Legacy use id as binaryObjectId
      originalName: dto.originalName,
      mimeType: dto.mimeType,
      size: dto.size,
      uploadedAt: dto.uploadedAt,
    };

    switch (dto.status) {
    case 'persisted': return { ...base, status: 'persisted' };
    case 'missing': return { ...base, status: 'missing' };
    case 'memory':
      return { ...base, status: 'memory' } as unknown as Attachment;
    default: {
      const _ex: never = dto.status;
      throw new Error(`Unhandled attachment status: ${_ex}`);
    }
    }
  }
};

const attachmentToDto = ({ domain }: { domain: Attachment }): AttachmentDto => {
  // Always output V2
  return {
    id: idToRaw({ id: domain.id }),
    binaryObjectId: idToRaw({ id: domain.binaryObjectId }),
    name: domain.originalName,
    status: domain.status,
  };
};

export const messageNodeToDomain = ({ dto }: { dto: MessageNodeDto }): MessageNode => {
  const common = {
    id: toMessageId({ raw: dto.id }),
    content: dto.content,
    timestamp: dto.timestamp,
    replies: {
      items: dto.replies.items.map(dto => messageNodeToDomain({ dto })),
    },
  };

  switch (dto.role) {
  case 'user':
    return {
      ...common,
      role: 'user',
      content: dto.content,
      attachments: dto.attachments?.map(dto => attachmentToDomain({ dto })),
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: lmParametersToDomain({ dto: dto.lmParameters }),
      toolCalls: undefined,
      results: undefined,
    };
  case 'assistant':
    return {
      ...common,
      role: 'assistant',
      content: dto.content,
      attachments: undefined,
      thinking: dto.thinking,
      error: undefined,
      modelId: dto.modelId,
      lmParameters: lmParametersToDomain({ dto: dto.lmParameters }),
      toolCalls: dto.toolCalls?.map(dto => ({ ...dto, id: toToolCallId({ raw: dto.id }) })),
      results: undefined,
    };
  case 'system':
    return {
      ...common,
      role: 'system',
      content: dto.content,
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    };
  case 'tool':
    return {
      ...common,
      role: 'tool',
      content: undefined,
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: dto.results.map(dto => {
        switch (dto.status) {
        case 'executing':
          return { toolCallId: toToolCallId({ raw: dto.toolCallId }), status: 'executing' };
        case 'success':
          return {
            toolCallId: toToolCallId({ raw: dto.toolCallId }),
            status: 'success',
            content: (() => {
              switch (dto.content.type) {
              case 'text':
                return dto.content
              case 'binary_object':
                return { type: 'binary_object', id: toBinaryObjectId({ raw: dto.content.id }) }
              default: {
                const _ex: never = dto.content
                throw new Error(`Unhandled tool result content: ${((_ex satisfies never) as { readonly type: string }).type}`)
              }
              }
            })(),
          };
        case 'error':
          return {
            toolCallId: toToolCallId({ raw: dto.toolCallId }),
            status: 'error',
            error: {
              code: dto.error.code,
              message: (() => {
                switch (dto.error.message.type) {
                case 'text':
                  return dto.error.message
                case 'binary_object':
                  return { type: 'binary_object', id: toBinaryObjectId({ raw: dto.error.message.id }) }
                default: {
                  const _ex: never = dto.error.message
                  throw new Error(`Unhandled tool error message: ${((_ex satisfies never) as { readonly type: string }).type}`)
                }
                }
              })(),
            },
          };
        default: {
          const _ex: never = dto;
          throw new Error(`Unhandled tool execution result status: ${(_ex as { status: string }).status}`);
        }
        }
      }),
    };
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
  }
  }
};

export const messageNodeToDto = ({ domain }: { domain: MessageNode }): MessageNodeDto => {
  const common = {
    id: idToRaw({ id: domain.id }),
    content: domain.content,
    timestamp: domain.timestamp,
    replies: {
      items: domain.replies.items.map(domain => messageNodeToDto({ domain })),
    },
  };

  switch (domain.role) {
  case 'user':
    return {
      ...common,
      role: 'user',
      content: domain.content,
      attachments: domain.attachments?.map(domain => attachmentToDto({ domain })),
      thinking: undefined,
      modelId: undefined,
      lmParameters: lmParametersToDto({ domain: domain.lmParameters }),
      toolCalls: undefined,
      results: undefined,
    };
  case 'assistant':
    return {
      ...common,
      role: 'assistant',
      content: domain.content,
      attachments: undefined,
      thinking: domain.thinking,
      modelId: domain.modelId,
      lmParameters: lmParametersToDto({ domain: domain.lmParameters }),
      toolCalls: domain.toolCalls?.map(domain => ({ ...domain, id: idToRaw({ id: domain.id }) })),
      results: undefined,
    };
  case 'system':
    return {
      ...common,
      role: 'system',
      content: domain.content,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    };
  case 'tool':
    return {
      ...common,
      role: 'tool',
      content: undefined,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: domain.results.map(domain => {
        switch (domain.status) {
        case 'executing':
          return { toolCallId: idToRaw({ id: domain.toolCallId }), status: 'executing' };
        case 'success':
          return {
            toolCallId: idToRaw({ id: domain.toolCallId }),
            status: 'success',
            content: (() => {
              switch (domain.content.type) {
              case 'text':
                return domain.content
              case 'binary_object':
                return { type: 'binary_object', id: idToRaw({ id: domain.content.id }) }
              default: {
                const _ex: never = domain.content
                throw new Error(`Unhandled tool result content: ${((_ex satisfies never) as { readonly type: string }).type}`)
              }
              }
            })(),
          };
        case 'error':
          return {
            toolCallId: idToRaw({ id: domain.toolCallId }),
            status: 'error',
            error: {
              code: domain.error.code,
              message: (() => {
                switch (domain.error.message.type) {
                case 'text':
                  return domain.error.message
                case 'binary_object':
                  return { type: 'binary_object', id: idToRaw({ id: domain.error.message.id }) }
                default: {
                  const _ex: never = domain.error.message
                  throw new Error(`Unhandled tool error message: ${((_ex satisfies never) as { readonly type: string }).type}`)
                }
                }
              })(),
            },
          };
        default: {
          const _ex: never = domain;
          throw new Error(`Unhandled tool execution result status: ${(_ex as { status: string }).status}`);
        }
        }
      }),
    };
  default: {
    const _ex: never = domain;
    throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
  }
  }
};

interface LegacyMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  thinking?: string;
  modelId?: string;
}

function migrateFlatMessagesToTree({ messages }: { messages: unknown[] }): MessageBranch {
  if (!messages || messages.length === 0) return { items: [] };
  const legacyMsgs = messages as LegacyMessage[];
  const nodes: MessageNode[] = legacyMsgs.map(m => {
    const common = {
      id: toMessageId({ raw: m.id }),
      content: m.content,
      timestamp: m.timestamp,
      replies: { items: [] },
    };
    switch (m.role) {
    case 'assistant':
      return {
        ...common,
        role: 'assistant',
        attachments: undefined,
        thinking: m.thinking,
        modelId: m.modelId,
        lmParameters: {
          temperature: undefined,
          topP: undefined,
          maxCompletionTokens: undefined,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: { effort: undefined }
        },
        toolCalls: undefined,
        results: undefined,
      } as AssistantMessageNode;
    case 'user':
      return {
        ...common,
        role: 'user',
        attachments: [],
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: {
          temperature: undefined,
          topP: undefined,
          maxCompletionTokens: undefined,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: { effort: undefined }
        },
        toolCalls: undefined,
        results: undefined,
      } as UserMessageNode;
    case 'system':
      return {
        ...common,
        role: 'system',
        attachments: undefined,
        thinking: undefined,
        error: undefined,
        modelId: undefined,
        lmParameters: undefined,
        toolCalls: undefined,
        results: undefined,
      } as SystemMessageNode;
    case 'tool':
      throw new Error('Tool role migration not implemented for legacy messages');
    default: {
      const _ex: never = m.role;
      throw new Error(`Unhandled role: ${_ex}`);
    }
    }
  });

  for (let i = 0; i < nodes.length - 1; i++) {
    const current = nodes[i];
    const next = nodes[i+1];
    if (current && next) {
      current.replies.items.push(next);
    }
  }
  return { items: nodes[0] ? [nodes[0]] : [] };
}

export const chatToDomain = ({ dto }: { dto: ChatDto }): Chat => {
  let root: MessageBranch = { items: [] };

  if (dto.root && dto.root.items && dto.root.items.length > 0) {
    root = { items: (dto.root.items as MessageNodeDto[]).map(dto => messageNodeToDomain({ dto })) };
  } else if (dto.messages && dto.messages.length > 0) {
    // Priority to legacy flat messages if tree is empty
    root = migrateFlatMessagesToTree({ messages: dto.messages });
  } else if (dto.root && !('items' in dto.root)) {
    // Handle edge case where root might be a single node
    root = { items: [messageNodeToDomain({ dto: dto.root as MessageNodeDto })] };
  }

  const {
    id, title, currentLeafId, createdAt, updatedAt,
    debugEnabled, endpoint, modelId, originChatId, originMessageId,
    systemPrompt, lmParameters
  } = dto;

  const endpointInfo = endpoint ? (() => {
    switch (endpoint.type) {
    case 'openai':
    case 'ollama':
      return {
        endpointType: endpoint.type as EndpointType,
        endpointUrl: endpoint.url || undefined,
        endpointHttpHeaders: endpoint.httpHeaders as [string, string][] | undefined,
      };
    case 'transformers_js':
      return {
        endpointType: endpoint.type as EndpointType,
        endpointUrl: undefined,
        endpointHttpHeaders: undefined,
      };
    default: {
      const _ex: never = endpoint;
      throw new Error(`Unhandled endpoint type: ${(_ex as { type: string }).type}`);
    }
    }
  })() : {
    endpointType: undefined,
    endpointUrl: undefined,
    endpointHttpHeaders: undefined,
  };

  return {
    id: toChatId({ raw: id }),
    title,
    root,
    currentLeafId: currentLeafId === undefined ? undefined : toMessageId({ raw: currentLeafId }),
    createdAt,
    updatedAt,
    debugEnabled: debugEnabled ?? false,
    ...endpointInfo,
    modelId,
    autoTitleEnabled: dto.autoTitleEnabled,
    titleModelId: dto.titleModelId,
    originChatId: originChatId === undefined ? undefined : toChatId({ raw: originChatId }),
    originMessageId: originMessageId === undefined ? undefined : toMessageId({ raw: originMessageId }),
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters: lmParametersToDomain({ dto: lmParameters }),
    mounts: dto.mounts?.map(dto => mountToDomain({ dto })),
    toolConfigs: toolConfigsToDomain({ toolConfigs: dto.experimental?.toolConfigs as ToolConfig[] | undefined }),
  };
};

export const chatMetaToSummary = ({ domain }: { domain: ChatMeta }): ChatSummary => ({
  id: domain.id,
  title: domain.title,
  updatedAt: domain.updatedAt,
});

export const chatMetaToDto = ({ domain }: { domain: ChatMeta }): ChatMetaDto => ({
  id: idToRaw({ id: domain.id }),
  title: domain.title,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
  debugEnabled: domain.debugEnabled,
  endpoint: domain.endpoint ? endpointToDto({ endpoint: domain.endpoint }) : undefined,
  modelId: domain.modelId,
  autoTitleEnabled: domain.autoTitleEnabled,
  titleModelId: domain.titleModelId,
  originChatId: domain.originChatId === undefined ? undefined : idToRaw({ id: domain.originChatId }),
  originMessageId: domain.originMessageId === undefined ? undefined : idToRaw({ id: domain.originMessageId }),
  systemPrompt: domain.systemPrompt,
  lmParameters: lmParametersToDto({ domain: domain.lmParameters }),
  currentLeafId: domain.currentLeafId === undefined ? undefined : idToRaw({ id: domain.currentLeafId }),
  mounts: domain.mounts?.map(domain => mountToDto({ domain })),
  experimental: toolConfigsToExperimentalDto({ toolConfigs: domain.toolConfigs }),
});

export const chatContentToDto = ({ domain }: { domain: ChatContent }): ChatContentDto => ({
  root: { items: domain.root.items.map(domain => messageNodeToDto({ domain })) },
  currentLeafId: domain.currentLeafId === undefined ? undefined : idToRaw({ id: domain.currentLeafId }),
});

export const chatContentToDomain = ({ dto }: { dto: ChatContentDto }): ChatContent => ({
  root: { items: dto.root.items.map(dto => messageNodeToDomain({ dto })) },
  currentLeafId: dto.currentLeafId === undefined ? undefined : toMessageId({ raw: dto.currentLeafId }),
});

export const chatToDto = ({ domain }: { domain: Chat }): ChatDto => {
  const {
    id, title, root, currentLeafId, createdAt, updatedAt,
    debugEnabled, endpointType, endpointUrl, endpointHttpHeaders,
    modelId, originChatId, originMessageId, systemPrompt, lmParameters
  } = domain;

  return {
    id: idToRaw({ id }),
    title,
    root: { items: root.items.map(domain => messageNodeToDto({ domain })) },
    currentLeafId: currentLeafId === undefined ? undefined : idToRaw({ id: currentLeafId }),
    createdAt,
    updatedAt,
    debugEnabled,
    endpoint: endpointType ? endpointToDto({ endpoint: {
      type: endpointType,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    } }) : undefined,
    modelId,
    autoTitleEnabled: domain.autoTitleEnabled,
    titleModelId: domain.titleModelId,
    originChatId: originChatId === undefined ? undefined : idToRaw({ id: originChatId }),
    originMessageId: originMessageId === undefined ? undefined : idToRaw({ id: originMessageId }),
    systemPrompt,
    lmParameters: lmParametersToDto({ domain: lmParameters }),
    mounts: domain.mounts?.map(domain => mountToDto({ domain })),
    experimental: toolConfigsToExperimentalDto({ toolConfigs: domain.toolConfigs }),
    messages: undefined,
  };
};

/**
 * High-level Sidebar assembly mapper.
 * Uses Hierarchy as the structural template.
 */
export const buildSidebarItemsFromHierarchy = (
  { hierarchy, chatMetas, chatGroups }: { hierarchy: Hierarchy, chatMetas: ChatMeta[], chatGroups: Omit<ChatGroup, 'items'>[] }
): SidebarItem[] => {
  const metaMap = new Map(chatMetas.map(m => [m.id, m]));
  const groupMap = new Map(chatGroups.map(g => [g.id, g]));

  const assembleNode = ({ node }: { node: HierarchyNode }): SidebarItem | null => {
    switch (node.type) {
    case 'chat': {
      const meta = metaMap.get(node.id);
      if (!meta) return null;
      return {
        id: `chat:${idToRaw({ id: node.id })}`,
        type: 'chat',
        chat: { ...chatMetaToSummary({ domain: meta }), groupId: null }
      };
    }
    case 'chat_group': {
      const groupMeta = groupMap.get(node.id);
      if (!groupMeta) return null;

      const nestedItems: ChatSidebarItem[] = node.chat_ids
        .map(cid => {
          const m = metaMap.get(cid);
          if (!m) return null;
          return {
            id: `chat:${idToRaw({ id: cid })}`,
            type: 'chat' as const,
            chat: { ...chatMetaToSummary({ domain: m }), groupId: groupMeta.id }
          } as ChatSidebarItem;
        })
        .filter((i): i is ChatSidebarItem => i !== null);

      return {
        id: `chat_group:${idToRaw({ id: node.id })}`,
        type: 'chat_group',
        chatGroup: { ...groupMeta, items: nestedItems }
      };
    }
    default: {
      const _ex: never = node;
      throw new Error(`Unhandled hierarchy node type: ${_ex}`);
    }
    }
  };

  return hierarchy.items
    .map((node) => assembleNode({ node }))
    .filter((i): i is SidebarItem => i !== null);
};

export const settingsToDomain = ({ dto }: { dto: SettingsDto }): Settings => {
  const { endpoint, providerProfiles, storageType, ...rest } = dto;

  const endpointInfo = (() => {
    switch (endpoint.type) {
    case 'openai':
    case 'ollama':
      return {
        endpointType: endpoint.type as EndpointType,
        endpointUrl: endpoint.url || undefined,
        endpointHttpHeaders: endpoint.httpHeaders as [string, string][] | undefined,
      };
    case 'transformers_js':
      return {
        endpointType: endpoint.type as EndpointType,
        endpointUrl: undefined,
        endpointHttpHeaders: undefined,
      };
    default: {
      const _ex: never = endpoint;
      throw new Error(`Unhandled endpoint type: ${(_ex as { type: string }).type}`);
    }
    }
  })();

  return {
    ...rest,
    ...endpointInfo,
    storageType: storageType as StorageType,
    experimental: {
      ...(rest.experimental?.markdownRendering === undefined
        ? {}
        : { markdownRendering: rest.experimental.markdownRendering }),
      toolConfigPersistence: rest.experimental?.toolConfigPersistence ?? 'disabled',
      fakeLm: rest.experimental?.fakeLm ?? 'disabled',
      sidebarSendMessageReorder: rest.experimental?.sidebarSendMessageReorder ?? 'disabled',
      ...(rest.experimental?.unreadable === undefined
        ? {}
        : { unreadable: rest.experimental.unreadable }),
    },
    providerProfiles: providerProfiles?.map(p => {
      const { endpoint: pEndpoint, ...pRest } = p;
      const pEndpointInfo = (() => {
        switch (pEndpoint.type) {
        case 'openai':
        case 'ollama':
          return {
            endpointType: pEndpoint.type as EndpointType,
            endpointUrl: pEndpoint.url || undefined,
            endpointHttpHeaders: pEndpoint.httpHeaders as [string, string][] | undefined,
          };
        case 'transformers_js':
          return {
            endpointType: pEndpoint.type as EndpointType,
            endpointUrl: undefined,
            endpointHttpHeaders: undefined,
          };
        default: {
          const _ex: never = pEndpoint;
          throw new Error(`Unhandled endpoint type: ${(_ex as { type: string }).type}`);
        }
        }
      })();
      return {
        ...pRest,
        id: toProviderProfileId({ raw: pRest.id }),
        ...pEndpointInfo,
        lmParameters: lmParametersToDomain({ dto: pRest.lmParameters }),
      };
    }) ?? [],
    lmParameters: lmParametersToDomain({ dto: rest.lmParameters }),
    mounts: rest.mounts.map(dto => mountToDomain({ dto })),
  };
};

export const settingsToDto = ({ domain }: { domain: Settings }): SettingsDto => {
  const {
    endpointType, endpointUrl, endpointHttpHeaders,
    storageType, providerProfiles, ...rest
  } = domain;

  return {
    endpoint: endpointToDto({ endpoint: {
      type: endpointType,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    } }),
    defaultModelId: rest.defaultModelId,
    titleModelId: rest.titleModelId,
    autoTitleEnabled: rest.autoTitleEnabled,
    storageType: storageType as StorageTypeDto,
    providerProfiles: (providerProfiles || []).map(p => {
      const {
        endpointType: pType, endpointUrl: pUrl, endpointHttpHeaders: pHeaders,
        ...pRest
      } = p;

      return {
        id: idToRaw({ id: pRest.id }),
        name: pRest.name,
        endpoint: endpointToDto({ endpoint: {
          type: pType,
          url: pUrl,
          httpHeaders: pHeaders,
        } }),
        defaultModelId: pRest.defaultModelId,
        titleModelId: pRest.titleModelId,
        systemPrompt: pRest.systemPrompt,
        lmParameters: lmParametersToDto({ domain: pRest.lmParameters }),
      };
    }),
    heavyContentAlertDismissed: rest.heavyContentAlertDismissed,
    systemPrompt: rest.systemPrompt,
    lmParameters: lmParametersToDto({ domain: rest.lmParameters }),
    experimental: {
      markdownRendering: rest.experimental?.markdownRendering,
      toolConfigPersistence: toolConfigPersistenceToExperimentalDto({
        persistence: rest.experimental?.toolConfigPersistence,
      }),
      fakeLm: fakeLmToExperimentalDto({
        status: rest.experimental?.fakeLm,
      }),
      sidebarSendMessageReorder: rest.experimental?.sidebarSendMessageReorder ?? 'disabled',
    },
    mounts: (domain.mounts || []).map(m => {
      const type = m.type;
      switch (type) {
      case 'volume':
        return {
          type: 'volume',
          volumeId: idToRaw({ id: m.volumeId }),
          mountPath: m.mountPath,
          readOnly: m.readOnly,
        };
      default: {
        const _ex: never = type;
        throw new Error(`Unhandled mount type: ${_ex}`);
      }
      }
    }),
  };
};

export const binaryObjectToDomain = ({ dto }: { dto: BinaryObjectDto }): BinaryObject => ({
  id: toBinaryObjectId({ raw: dto.id }),
  mimeType: dto.mimeType,
  size: dto.size,
  createdAt: dto.createdAt,
  name: dto.name,
});

export const binaryObjectToDto = ({ domain }: { domain: BinaryObject }): BinaryObjectDto => ({
  id: idToRaw({ id: domain.id }),
  mimeType: domain.mimeType,
  size: domain.size,
  createdAt: domain.createdAt,
  name: domain.name,
});


export const volumeToDomain = ({ dto }: { dto: VolumeDto }): Volume => ({
  id: toVolumeId({ raw: dto.id }),
  name: dto.name,
  type: dto.type,
  createdAt: dto.createdAt,
});

export const volumeToDto = ({ domain }: { domain: Volume }): VolumeDto => {
  switch (domain.type) {
  case 'opfs':
    return {
      type: 'opfs',
      id: idToRaw({ id: domain.id }),
      name: domain.name,
      createdAt: domain.createdAt,
    };
  case 'host':
    return {
      type: 'host',
      id: idToRaw({ id: domain.id }),
      name: domain.name,
      createdAt: domain.createdAt,
    };
  default: {
    const _ex: never = domain.type;
    throw new Error(`Unhandled volume type: ${(_ex as { type: string }).type}`);
  }
  }
};
