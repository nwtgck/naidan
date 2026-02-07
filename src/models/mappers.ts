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
} from './dto';
import type { 
  Role, 
  MessageNode, 
  MessageBranch,
  Chat, 
  ChatGroup,
  ChatSummary,
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
  lmParameters: dto.lmParameters,
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
  
  const items: SidebarItem[] = chatIds.map(cid => {
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
    systemPrompt: dto.systemPrompt as SystemPrompt | undefined,
    lmParameters: dto.lmParameters,
  };
};

export const chatGroupToDto = (domain: ChatGroup): ChatGroupDto => ({
  id: domain.id,
  name: domain.name,
  isCollapsed: domain.isCollapsed,
  updatedAt: domain.updatedAt,
  endpoint: domain.endpoint ? endpointToDto(domain.endpoint) : undefined,
  modelId: domain.modelId,
  systemPrompt: domain.systemPrompt,
  lmParameters: domain.lmParameters,
});

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

export const messageNodeToDomain = (dto: MessageNodeDto): MessageNode => ({
  id: dto.id,
  role: roleToDomain(dto.role),
  content: dto.content,
  attachments: dto.attachments?.map(attachmentToDomain),
  timestamp: dto.timestamp,
  thinking: dto.thinking,
  modelId: dto.modelId,
  replies: {
    items: dto.replies.items.map(messageNodeToDomain),
  },
});

export const messageNodeToDto = (domain: MessageNode): MessageNodeDto => ({
  id: domain.id,
  role: domain.role as RoleDto,
  content: domain.content,
  attachments: domain.attachments?.map(attachmentToDto),
  timestamp: domain.timestamp,
  thinking: domain.thinking,
  modelId: domain.modelId,
  replies: {
    items: domain.replies.items.map(messageNodeToDto),
  },
});

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
  const nodes: MessageNode[] = legacyMsgs.map(m => ({
    id: m.id,
    role: m.role,
    content: m.content,
    timestamp: m.timestamp,
    thinking: m.thinking,
    modelId: m.modelId,
    replies: { items: [] },
  }));
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
    originChatId,
    originMessageId,
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters,
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
  originChatId: domain.originChatId,
  originMessageId: domain.originMessageId,
  systemPrompt: domain.systemPrompt,
  lmParameters: domain.lmParameters,
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
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters,
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
        
      const nestedItems: SidebarItem[] = node.chat_ids
        .map(cid => {
          const m = metaMap.get(cid);
          if (!m) return null;
          return { 
            id: `chat:${cid}`, 
            type: 'chat' as const, 
            chat: { ...chatMetaToSummary(m), groupId: groupMeta.id } 
          } as SidebarItem;
        })
        .filter((i): i is SidebarItem => i !== null);

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
      };
    }) ?? [],
  };
};

export const settingsToDto = (domain: Settings): SettingsDto => {
  const { 
    endpointType, endpointUrl, endpointHttpHeaders, 
    storageType, providerProfiles, ...rest 
  } = domain;

  return {
    ...rest,
    endpoint: endpointToDto({
      type: endpointType,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    }),
    storageType: storageType as StorageTypeDto,
    providerProfiles: (providerProfiles || []).map(p => {
      const { 
        endpointType: pType, endpointUrl: pUrl, endpointHttpHeaders: pHeaders, 
        ...pRest 
      } = p;
      
      return {
        ...pRest,
        endpoint: endpointToDto({
          type: pType,
          url: pUrl,
          httpHeaders: pHeaders,
        }),
      };
    }),
  };
};