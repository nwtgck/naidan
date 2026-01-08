/**
 * Mappers
 * 
 * This layer is responsible for translating between the Persistence layer (DTOs)
 * and the Business layer (Domain). It ensures that the Domain remains isolated
 * from any historical or technical constraints of the underlying storage format.
 */
import type { 
  RoleDto, 
  MessageDto, 
  ChatDto, 
  SettingsDto,
  EndpointTypeDto,
  StorageTypeDto
} from './dto';
import type { 
  Role, 
  Message, 
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

export const messageToDomain = (dto: MessageDto): Message => ({
  id: dto.id,
  role: roleToDomain(dto.role),
  content: dto.content,
  timestamp: dto.timestamp,
  thinking: dto.thinking,
});

export const chatToDomain = (dto: ChatDto): Chat => ({
  id: dto.id,
  title: dto.title,
  messages: dto.messages.map(messageToDomain),
  modelId: dto.modelId,
  createdAt: dto.createdAt,
  updatedAt: dto.updatedAt,
  debugEnabled: dto.debugEnabled ?? false,
  endpointType: dto.endpointType as EndpointType | undefined,
  endpointUrl: dto.endpointUrl,
  overrideModelId: dto.overrideModelId,
});

export const chatToDto = (domain: Chat): ChatDto => ({
  id: domain.id,
  title: domain.title,
  messages: domain.messages.map(m => ({
    id: m.id,
    role: m.role as RoleDto,
    content: m.content,
    timestamp: m.timestamp,
    thinking: m.thinking,
  })),
  modelId: domain.modelId,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
  debugEnabled: domain.debugEnabled,
  endpointType: domain.endpointType as EndpointTypeDto | undefined,
  endpointUrl: domain.endpointUrl,
  overrideModelId: domain.overrideModelId,
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
