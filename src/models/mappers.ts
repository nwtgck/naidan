/**
 * Mappers
 */
import type { 
  RoleDto, 
  MessageNodeDto,
  ChatDto, 
  SettingsDto,
  EndpointTypeDto,
  StorageTypeDto
} from './dto';
import type { 
  Role, 
  MessageNode, 
  MessageBranch,
  Chat, 
  Settings,
  EndpointType,
  StorageType
} from './types';

export const roleToDomain = (dto: RoleDto): Role => {
  switch (dto) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'system': return 'system';
    default: throw new Error(`Unknown role: ${dto}`);
  }
};

// --- Recursive Message Mapping ---

export const messageNodeToDomain = (dto: MessageNodeDto): MessageNode => ({
  id: dto.id,
  role: roleToDomain(dto.role),
  content: dto.content,
  timestamp: dto.timestamp,
  thinking: dto.thinking,
  replies: {
    items: dto.replies.items.map(messageNodeToDomain)
  }
});

export const messageNodeToDto = (domain: MessageNode): MessageNodeDto => ({
  id: domain.id,
  role: domain.role as RoleDto,
  content: domain.content,
  timestamp: domain.timestamp,
  thinking: domain.thinking,
  replies: {
    items: domain.replies.items.map(messageNodeToDto)
  }
});

// --- Legacy Migration: Flat Array to Tree ---

interface LegacyMessage {
  id: string;
  role: Role;
  content: string;
  timestamp: number;
  thinking?: string;
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
    replies: { items: [] }
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

// --- Chat Mapping ---

export const chatToDomain = (dto: ChatDto): Chat => {
  let root: MessageBranch = { items: [] };
  
  if (dto.root && dto.root.items && dto.root.items.length > 0) {
    // Newest format
    root = {
      items: (dto.root.items as MessageNodeDto[]).map(messageNodeToDomain)
    };
  } else if (dto.root && !('items' in dto.root)) {
    // Middle format (single node root - handle if passed as raw node)
    root = {
      items: [messageNodeToDomain(dto.root as MessageNodeDto)]
    };
  } else if (dto.messages && dto.messages.length > 0) {
    // Oldest format (flat array)
    root = migrateFlatMessagesToTree(dto.messages);
  }

  return {
    id: dto.id,
    title: dto.title,
    root,
    currentLeafId: dto.currentLeafId,
    // ... rest same
    modelId: dto.modelId,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    debugEnabled: dto.debugEnabled ?? false,
    endpointType: dto.endpointType as EndpointType | undefined,
    endpointUrl: dto.endpointUrl,
    overrideModelId: dto.overrideModelId,
    originChatId: dto.originChatId,
    originMessageId: dto.originMessageId,
  };
};

export const chatToDto = (domain: Chat): ChatDto => ({
  id: domain.id,
  title: domain.title,
  root: {
    items: domain.root.items.map(messageNodeToDto)
  },
  currentLeafId: domain.currentLeafId,
  modelId: domain.modelId,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
  debugEnabled: domain.debugEnabled,
  endpointType: domain.endpointType as EndpointTypeDto | undefined,
  endpointUrl: domain.endpointUrl,
  overrideModelId: domain.overrideModelId,
  originChatId: domain.originChatId,
  originMessageId: domain.originMessageId,
});

export const settingsToDomain = (dto: SettingsDto): Settings => ({
  endpointType: dto.endpointType as EndpointType,
  endpointUrl: dto.endpointUrl,
  defaultModelId: dto.defaultModelId,
  storageType: dto.storageType as StorageType,
});

export const settingsToDto = (domain: Settings): SettingsDto => ({
  endpointType: domain.endpointType as EndpointTypeDto,
  endpointUrl: domain.endpointUrl,
  defaultModelId: domain.defaultModelId,
  storageType: domain.storageType as StorageTypeDto,
});