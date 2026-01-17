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
  EndpointTypeDto,
  StorageTypeDto,
  AttachmentDto,
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
  StorageType,
  SystemPrompt,
  Attachment,
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
 * Converts a Chat Group DTO and associated Chat Meta DTOs into a Domain ChatGroup.
 */
export const chatGroupToDomain = (dto: ChatGroupDto, chatMetaDtos: ChatMetaDto[] = []): ChatGroup => {
  const nestedItems: SidebarItem[] = chatMetaDtos
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(c => ({
      id: `chat:${c.id}`,
      type: 'chat',
      chat: chatMetaToSummary(c),
    }));

  return {
    id: dto.id,
    name: dto.name,
    isCollapsed: dto.isCollapsed,
    updatedAt: dto.updatedAt,
    items: nestedItems,
    endpoint: dto.endpoint ? {
      type: dto.endpoint.type as EndpointType,
      url: dto.endpoint.url,
      httpHeaders: dto.endpoint.httpHeaders,
    } : undefined,
    modelId: dto.modelId,
    systemPrompt: dto.systemPrompt as SystemPrompt | undefined,
    lmParameters: dto.lmParameters,
  };
};

export const chatGroupToDto = (domain: ChatGroup, index: number): ChatGroupDto => ({
  id: domain.id,
  name: domain.name,
  isCollapsed: domain.isCollapsed,
  updatedAt: domain.updatedAt,
  order: index,
  endpoint: domain.endpoint ? {
    type: domain.endpoint.type as EndpointTypeDto,
    url: domain.endpoint.url,
    httpHeaders: domain.endpoint.httpHeaders,
  } : undefined,
  modelId: domain.modelId,
  systemPrompt: domain.systemPrompt,
  lmParameters: domain.lmParameters,
});

const attachmentToDomain = (dto: AttachmentDto): Attachment => {
  const base = {
    id: dto.id,
    originalName: dto.originalName,
    mimeType: dto.mimeType,
    size: dto.size,
    uploadedAt: dto.uploadedAt,
  };

  if (dto.status === 'persisted') return { ...base, status: 'persisted' };
  if (dto.status === 'missing') return { ...base, status: 'missing' };
  
  // For 'memory' status from DTO, we might not have the blob yet.
  // We cast to unknown then Attachment to allow this intermediate state which is restored by providers.
  return { ...base, status: 'memory' } as unknown as Attachment;
};

const attachmentToDto = (domain: Attachment): AttachmentDto => {
  return {
    id: domain.id,
    originalName: domain.originalName,
    mimeType: domain.mimeType,
    size: domain.size,
    uploadedAt: domain.uploadedAt,
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
    // Handle edge case where root might be a single node (unlikely with current Zod but safe)
    root = { items: [messageNodeToDomain(dto.root as MessageNodeDto)] };
  }

  const { 
    id, title, groupId, currentLeafId, createdAt, updatedAt, 
    debugEnabled, endpoint, overrideModelId, originChatId, originMessageId, 
    systemPrompt, lmParameters 
  } = dto;

  return {
    id,
    title,
    groupId,
    root,
    currentLeafId,
    createdAt,
    updatedAt,
    debugEnabled: debugEnabled ?? false,
    endpointType: endpoint?.type as EndpointType | undefined,
    endpointUrl: endpoint?.url,
    endpointHttpHeaders: endpoint?.httpHeaders,
    overrideModelId,
    originChatId,
    originMessageId,
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters,
  };
};

export const chatMetaToSummary = (dto: ChatMetaDto): ChatSummary => ({
  id: dto.id,
  title: dto.title,
  updatedAt: dto.updatedAt,
  groupId: dto.groupId,
});

export const chatToDto = (domain: Chat, index: number): ChatDto => {
  const { 
    id, title, groupId, root, currentLeafId, createdAt, updatedAt, 
    debugEnabled, endpointType, endpointUrl, endpointHttpHeaders, 
    overrideModelId, originChatId, originMessageId, systemPrompt, lmParameters 
  } = domain;

  return {
    id,
    title,
    groupId,
    order: index,
    root: { items: root.items.map(messageNodeToDto) },
    currentLeafId,
    createdAt,
    updatedAt,
    debugEnabled,
    endpoint: endpointType ? {
      type: endpointType as EndpointTypeDto,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    } : undefined,
    overrideModelId,
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters,
  };
};

/**
 * Builds the hierarchical Sidebar structure from raw DTOs.
 * Uses ChatMetaDto for performance.
 */
export const buildSidebarItemsFromDtos = (groupDtos: ChatGroupDto[], allChatMetaDtos: ChatMetaDto[]): SidebarItem[] => {
  type SortableSidebarItem = SidebarItem & { _order: number };
  const items: SortableSidebarItem[] = [];
  
  groupDtos.forEach(gDto => {
    const groupChats = allChatMetaDtos.filter(c => c.groupId === gDto.id);
    items.push({ 
      id: `chat_group:${gDto.id}`, 
      type: 'chat_group', 
      chatGroup: chatGroupToDomain(gDto, groupChats),
      _order: gDto.order ?? 0,
    });
  });
  
  allChatMetaDtos
    .filter(c => !c.groupId)
    .forEach(cDto => {
      items.push({ 
        id: `chat:${cDto.id}`, 
        type: 'chat', 
        chat: chatMetaToSummary(cDto),
        _order: cDto.order ?? 0,
      });
    });
    
  return items
    .sort((a, b) => a._order - b._order)
    .map((item) => {
      const { _order: _o, ...rest } = item;
      return rest as SidebarItem;
    });
};

export const settingsToDomain = (dto: SettingsDto): Settings => {
  const { endpoint, providerProfiles, storageType, ...rest } = dto;
  return {
    ...rest,
    endpointType: endpoint.type as EndpointType,
    endpointUrl: endpoint.url,
    endpointHttpHeaders: endpoint.httpHeaders,
    storageType: storageType as StorageType,
    providerProfiles: providerProfiles?.map(p => {
      const { endpoint: pEndpoint, ...pRest } = p;
      return {
        ...pRest,
        endpointType: pEndpoint.type as EndpointType,
        endpointUrl: pEndpoint.url,
        endpointHttpHeaders: pEndpoint.httpHeaders,
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
    endpoint: {
      type: endpointType as EndpointTypeDto,
      url: endpointUrl,
      httpHeaders: endpointHttpHeaders,
    },
    storageType: storageType as StorageTypeDto,
    providerProfiles: providerProfiles.map(p => {
      const { 
        endpointType: pType, endpointUrl: pUrl, endpointHttpHeaders: pHeaders, 
        ...pRest 
      } = p;
      return {
        ...pRest,
        endpoint: {
          type: pType as EndpointTypeDto,
          url: pUrl,
          httpHeaders: pHeaders,
        },
      };
    }),
  };
};
