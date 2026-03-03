/**
 * Mappers
 */
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
} from './types';

export const roleToDomain = (dto: RoleDto): Role => {
  switch (dto) {
  case 'user': return 'user';
  case 'assistant': return 'assistant';
  case 'system': return 'system';
  default: throw new Error(`Unknown role: ${dto}`);
  }
};

/**
 * Hierarchy Mappers
 */
export const hierarchyToDomain = (dto: HierarchyDto): Hierarchy => ({
  items: dto.items.map(item => {
    switch (item.type) {
    case 'chat':
      return { type: 'chat', id: item.id };
    case 'chat_group':
      return { type: 'chat_group', id: item.id, chat_ids: item.chat_ids };
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled hierarchy item type: ${_ex}`);
    }
    }
  }),
});

export const hierarchyToDto = (domain: Hierarchy): HierarchyDto => ({
  items: domain.items.map(item => {
    switch (item.type) {
    case 'chat':
      return { type: 'chat', id: item.id };
    case 'chat_group':
      return { type: 'chat_group', id: item.id, chat_ids: item.chat_ids };
    default: {
      const _ex: never = item;
      throw new Error(`Unhandled hierarchy item type: ${_ex}`);
    }
    }
  }),
});

export const chatMetaToDomain = (dto: ChatMetaDto): ChatMeta => ({
  id: dto.id,
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
  lmParameters: lmParametersToDomain(dto.lmParameters),
  autoTitleEnabled: dto.autoTitleEnabled,
  titleModelId: dto.titleModelId,
  currentLeafId: dto.currentLeafId,
  originChatId: dto.originChatId,
  originMessageId: dto.originMessageId,
});

/**
 * Converts a Chat Group DTO into a Domain ChatGroup.
 * Resolves nested items using the hierarchy and provided chat metadata.
 */
export const chatGroupToDomain = (
  dto: ChatGroupDto,
  hierarchy: Hierarchy,
  chatMetas: ChatMeta[]
): ChatGroup => {
  const node = hierarchy.items.find(
    i => i.type === 'chat_group' && i.id === dto.id
  ) as HierarchyChatGroupNode | undefined;

  const chatIds = node?.chat_ids || [];

  const items: ChatSidebarItem[] = chatIds.map(cid => {
    const meta = chatMetas.find(m => m.id === cid);
    return {
      id: `chat:${cid}`,
      type: 'chat',
      chat: {
        id: cid,
        title: meta?.title || null,
        updatedAt: meta?.updatedAt || 0,
        groupId: dto.id
      }
    };
  });

  return {
    id: dto.id,
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
    lmParameters: lmParametersToDomain(dto.lmParameters),
  };
};

export const chatGroupToDto = (domain: ChatGroup): ChatGroupDto => ({
  id: domain.id,
  name: domain.name,
  isCollapsed: domain.isCollapsed,
  updatedAt: domain.updatedAt,
  endpoint: domain.endpoint ? endpointToDto(domain.endpoint) : undefined,
  modelId: domain.modelId,
  autoTitleEnabled: domain.autoTitleEnabled,
  titleModelId: domain.titleModelId,
  systemPrompt: domain.systemPrompt,
  lmParameters: lmParametersToDto(domain.lmParameters),
});

export const lmParametersToDomain = (
  dto: LmParametersDto | undefined
): LmParameters => {
  if (!dto) {
    return {
      temperature: undefined,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: { effort: undefined },
    };
  }
  return {
    temperature: dto.temperature,
    topP: dto.topP,
    maxCompletionTokens: dto.maxCompletionTokens,
    presencePenalty: dto.presencePenalty,
    frequencyPenalty: dto.frequencyPenalty,
    stop: dto.stop,
    reasoning: {
      effort: dto.reasoning?.effort,
    },
  };
};

export const lmParametersToDto = (
  domain: LmParameters | undefined
): LmParametersDto | undefined => {
  if (!domain) return undefined;
  return {
    temperature: domain.temperature,
    topP: domain.topP,
    maxCompletionTokens: domain.maxCompletionTokens,
    presencePenalty: domain.presencePenalty,
    frequencyPenalty: domain.frequencyPenalty,
    stop: domain.stop,
    reasoning: domain.reasoning ? {
      effort: domain.reasoning.effort,
    } : undefined,
  };
};

export const endpointToDto = (endpoint: Endpoint): EndpointDto => {
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

const attachmentToDomain = (dto: AttachmentDto): Attachment => {
  if ('binaryObjectId' in dto) {
    // V2
    const base = {
      id: dto.id,
      binaryObjectId: dto.binaryObjectId,
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
      id: dto.id,
      binaryObjectId: dto.id, // Legacy use id as binaryObjectId
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

const attachmentToDto = (domain: Attachment): AttachmentDto => {
  // Always output V2
  return {
    id: domain.id,
    binaryObjectId: domain.binaryObjectId,
    name: domain.originalName,
    status: domain.status,
  };
};

export const messageNodeToDomain = (dto: MessageNodeDto): MessageNode => {
  const common = {
    id: dto.id,
    content: dto.content,
    timestamp: dto.timestamp,
    replies: {
      items: dto.replies.items.map(messageNodeToDomain),
    },
  };

  switch (dto.role) {
  case 'user':
    return {
      ...common,
      role: 'user',
      attachments: dto.attachments?.map(attachmentToDomain),
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: lmParametersToDomain(dto.lmParameters),
    };
  case 'assistant':
    return {
      ...common,
      role: 'assistant',
      attachments: undefined,
      thinking: dto.thinking,
      error: dto.error,
      modelId: dto.modelId,
      lmParameters: lmParametersToDomain(dto.lmParameters),
    };
  case 'system':
    return {
      ...common,
      role: 'system',
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
    };
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
  }
  }
};

export const messageNodeToDto = (domain: MessageNode): MessageNodeDto => {
  const common = {
    id: domain.id,
    content: domain.content,
    timestamp: domain.timestamp,
    replies: {
      items: domain.replies.items.map(messageNodeToDto),
    },
  };

  switch (domain.role) {
  case 'user':
    return {
      ...common,
      role: 'user',
      attachments: domain.attachments?.map(attachmentToDto),
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: lmParametersToDto(domain.lmParameters),
    };
  case 'assistant':
    return {
      ...common,
      role: 'assistant',
      attachments: undefined,
      thinking: domain.thinking,
      error: domain.error,
      modelId: domain.modelId,
      lmParameters: lmParametersToDto(domain.lmParameters),
    };
  case 'system':
    return {
      ...common,
      role: 'system',
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
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

function migrateFlatMessagesToTree(messages: unknown[]): MessageBranch {
  if (!messages || messages.length === 0) return { items: [] };
  const legacyMsgs = messages as LegacyMessage[];
  const nodes: MessageNode[] = legacyMsgs.map(m => {
    const common = {
      id: m.id,
      content: m.content,
      timestamp: m.timestamp,
      replies: { items: [] },
    };
    if (m.role === 'assistant') {
      return {
        ...common,
        role: 'assistant',
        attachments: undefined,
        thinking: m.thinking,
        modelId: m.modelId,
        lmParameters: { reasoning: { effort: undefined } },
      } as AssistantMessageNode;
    }
    if (m.role === 'user') {
      return {
        ...common,
        role: 'user',
        attachments: [],
        thinking: undefined,
        error: undefined,
        modelId: undefined,
      } as UserMessageNode;
    }
    return {
      ...common,
      role: 'system',
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
    } as SystemMessageNode;
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

export const chatToDomain = (dto: ChatDto): Chat => {
  let root: MessageBranch = { items: [] };

  if (dto.root && dto.root.items && dto.root.items.length > 0) {
    root = { items: (dto.root.items as MessageNodeDto[]).map(messageNodeToDomain) };
  } else if (dto.messages && dto.messages.length > 0) {
    // Priority to legacy flat messages if tree is empty
    root = migrateFlatMessagesToTree(dto.messages);
  } else if (dto.root && !('items' in dto.root)) {
    // Handle edge case where root might be a single node
    root = { items: [messageNodeToDomain(dto.root as MessageNodeDto)] };
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
    id,
    title,
    root,
    currentLeafId,
    createdAt,
    updatedAt,
    debugEnabled: debugEnabled ?? false,
    ...endpointInfo,
    modelId,
    autoTitleEnabled: dto.autoTitleEnabled,
    titleModelId: dto.titleModelId,
    originChatId,
    originMessageId,
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters: lmParametersToDomain(lmParameters),
  };
};

export const chatMetaToSummary = (domain: ChatMeta): ChatSummary => ({
  id: domain.id,
  title: domain.title,
  updatedAt: domain.updatedAt,
});

export const chatMetaToDto = (domain: ChatMeta): ChatMetaDto => ({
  id: domain.id,
  title: domain.title,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
  debugEnabled: domain.debugEnabled,
  endpoint: domain.endpoint ? endpointToDto(domain.endpoint) : undefined,
  modelId: domain.modelId,
  autoTitleEnabled: domain.autoTitleEnabled,
  titleModelId: domain.titleModelId,
  originChatId: domain.originChatId,
  originMessageId: domain.originMessageId,
  systemPrompt: domain.systemPrompt,
  lmParameters: lmParametersToDto(domain.lmParameters),
  currentLeafId: domain.currentLeafId,
});

export const chatContentToDto = (domain: ChatContent): ChatContentDto => ({
  root: { items: domain.root.items.map(messageNodeToDto) },
  currentLeafId: domain.currentLeafId,
});

export const chatContentToDomain = (dto: ChatContentDto): ChatContent => ({
  root: { items: dto.root.items.map(messageNodeToDomain) },
  currentLeafId: dto.currentLeafId,
});

export const chatToDto = (domain: Chat): ChatDto => {
  const {
    id, title, root, currentLeafId, createdAt, updatedAt,
    debugEnabled, endpointType, endpointUrl, endpointHttpHeaders,
    modelId, originChatId, originMessageId, systemPrompt, lmParameters
  } = domain;

  return {
    id,
    title,
    root: { items: root.items.map(messageNodeToDto) },
    currentLeafId,
    createdAt,
    updatedAt,
    debugEnabled,
    endpoint: endpointType ? endpointToDto({
      type: endpointType,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    }) : undefined,
    modelId,
    autoTitleEnabled: domain.autoTitleEnabled,
    titleModelId: domain.titleModelId,
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters: lmParametersToDto(lmParameters),
    messages: undefined,
  };
};

/**
 * High-level Sidebar assembly mapper.
 * Uses Hierarchy as the structural template.
 */
export const buildSidebarItemsFromHierarchy = (
  hierarchy: Hierarchy,
  chatMetas: ChatMeta[],
  chatGroups: Omit<ChatGroup, 'items'>[]
): SidebarItem[] => {
  const metaMap = new Map(chatMetas.map(m => [m.id, m]));
  const groupMap = new Map(chatGroups.map(g => [g.id, g]));

  const assembleNode = (node: HierarchyNode): SidebarItem | null => {
    switch (node.type) {
    case 'chat': {
      const meta = metaMap.get(node.id);
      if (!meta) return null;
      return {
        id: `chat:${node.id}`,
        type: 'chat',
        chat: { ...chatMetaToSummary(meta), groupId: null }
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
            id: `chat:${cid}`,
            type: 'chat' as const,
            chat: { ...chatMetaToSummary(m), groupId: groupMeta.id }
          } as ChatSidebarItem;
        })
        .filter((i): i is ChatSidebarItem => i !== null);

      return {
        id: `chat_group:${node.id}`,
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
    .map(assembleNode)
    .filter((i): i is SidebarItem => i !== null);
};

export const settingsToDomain = (dto: SettingsDto): Settings => {
  const { endpoint, providerProfiles, storageType, experimental, ...rest } = dto;

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
        ...pEndpointInfo,
        lmParameters: lmParametersToDomain(pRest.lmParameters),
      };
    }) ?? [],
    lmParameters: lmParametersToDomain(rest.lmParameters),
    experimental: experimental ? {
      markdownRendering: experimental.markdownRendering ?? undefined
    } : undefined,
  };
};

export const settingsToDto = (domain: Settings): SettingsDto => {
  const {
    endpointType, endpointUrl, endpointHttpHeaders,
    storageType, providerProfiles, experimental, ...rest
  } = domain;

  return {
    endpoint: endpointToDto({
      type: endpointType,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    }),
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
        id: pRest.id,
        name: pRest.name,
        endpoint: endpointToDto({
          type: pType,
          url: pUrl,
          httpHeaders: pHeaders,
        }),
        defaultModelId: pRest.defaultModelId,
        titleModelId: pRest.titleModelId,
        systemPrompt: pRest.systemPrompt,
        lmParameters: lmParametersToDto(pRest.lmParameters),
      };
    }),
    heavyContentAlertDismissed: rest.heavyContentAlertDismissed,
    systemPrompt: rest.systemPrompt,
    lmParameters: lmParametersToDto(rest.lmParameters),
    experimental: experimental ? {
      markdownRendering: experimental.markdownRendering ?? undefined
    } : undefined,
  };
};

export const binaryObjectToDomain = (dto: BinaryObjectDto): BinaryObject => ({
  id: dto.id,
  mimeType: dto.mimeType,
  size: dto.size,
  createdAt: dto.createdAt,
  name: dto.name,
});

export const binaryObjectToDto = (domain: BinaryObject): BinaryObjectDto => ({
  id: domain.id,
  mimeType: domain.mimeType,
  size: domain.size,
  createdAt: domain.createdAt,
  name: domain.name,
});
