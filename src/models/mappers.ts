/**
 * Mappers
 */
import type { 
  RoleDto, 
  MessageNodeDto,
  ChatDto, 
  ChatGroupDto,
  SettingsDto,
  EndpointTypeDto,
  StorageTypeDto
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

export const chatGroupToDomain = (dto: ChatGroupDto, groupItems: SidebarItem[] = []): ChatGroup => ({
  id: dto.id,
  name: dto.name,
  isCollapsed: dto.isCollapsed,
  order: dto.order,
  updatedAt: dto.updatedAt,
  items: groupItems.sort((a, b) => a.order - b.order),
});

export const chatGroupToDto = (domain: ChatGroup, index: number): ChatGroupDto => ({
  id: domain.id,
  name: domain.name,
  isCollapsed: domain.isCollapsed,
  updatedAt: domain.updatedAt,
  order: index,
});

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

export const chatToDomain = (dto: ChatDto): Chat => {
  let root: MessageBranch = { items: [] };
  if (dto.root && dto.root.items && dto.root.items.length > 0) {
    root = { items: (dto.root.items as MessageNodeDto[]).map(messageNodeToDomain) };
  } else if (dto.root && !('items' in dto.root)) {
    root = { items: [messageNodeToDomain(dto.root as MessageNodeDto)] };
  } else if (dto.messages && dto.messages.length > 0) {
    root = migrateFlatMessagesToTree(dto.messages);
  }

  return {
    id: dto.id,
    title: dto.title,
    groupId: dto.groupId,
    order: dto.order ?? 0,
    root,
    currentLeafId: dto.currentLeafId,
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
  groupId: domain.groupId,
  order: domain.order,
  root: { items: domain.root.items.map(messageNodeToDto) },
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

export const buildSidebarItems = (groups: ChatGroup[], allChats: ChatSummary[]): SidebarItem[] => {
  const items: SidebarItem[] = [];
  
  groups.forEach(g => {
    // Each group's items are built from chats belonging to it
    const groupChats = allChats.filter(c => c.groupId === g.id);
    const nestedItems: SidebarItem[] = groupChats.map(c => ({
      id: `chat:${c.id}`,
      type: 'chat',
      chat: c,
      order: c.order
    }));
    
    items.push({ 
      id: `group:${g.id}`, 
      type: 'group', 
      group: { ...g, items: nestedItems.sort((a, b) => a.order - b.order) }, 
      order: g.order 
    });
  });
  
  allChats
    .filter(c => !c.groupId)
    .forEach(c => {
      items.push({ id: `chat:${c.id}`, type: 'chat', chat: c, order: c.order });
    });
    
  return items.sort((a, b) => a.order - b.order);
};

export const settingsToDomain = (dto: SettingsDto): Settings => ({
  ...dto,
  endpointType: dto.endpointType as EndpointType,
  storageType: dto.storageType as StorageType,
});

export const settingsToDto = (domain: Settings): SettingsDto => ({
  ...domain,
  endpointType: domain.endpointType as EndpointTypeDto,
  storageType: domain.storageType as StorageTypeDto,
});