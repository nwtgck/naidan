/**
 * Mappers
 */
import type { TextOrBinaryObject, ToolConfig, ToolExecutionResult } from '@/01-models/tool';
import type {
  ExperimentalToolConfigDto,
  ExperimentalToolConfigsDto,
} from '@/00-storage/00-dto/experimental.dto';

import type {
  RoleDto,
  MessageNodeDto,
  TextOrBinaryObjectDto,
  ToolCallDto,
  ToolExecutionResultDto,
  ChatDto,
  ChatDtoV2,
  ChatMetaDto,
  ChatMetaDtoV2,
  ChatGroupDto,
  ChatGroupDtoV2,
  SettingsDto,
  SettingsDtoV2,
  EndpointDto,
  StorageTypeDto,
  AttachmentDto,
  HierarchyDto,
  ChatContentDto,
  BinaryObjectDto,
  LmParametersDto,
  MountDto,
  VolumeDto,
} from '@/00-storage/00-dto/dto';
import type {
  Role,
  MessageNode,
  AssistantMessageNode,
  UserMessageNode,
  SystemMessageNode,
  ToolMessageNode,
  ToolCall,
  MessageBranch,
  Chat,
  ChatGroup,
  ChatSummary,
  ChatSidebarItem,
  SidebarItem,
  Settings,
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
  SettingsTitleGeneration,
  ScopedTitleGeneration,
} from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
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
} from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';
import {
  LM_PARAMETER_KEYS,
  normalizeLmParameters,
  REASONING_PARAMETER_KEYS,
} from '@/utils/lm-parameters';


/**
 * Persistence mappers deliberately use both source-side destructuring checks and
 * destination-side exact object construction. Persisted DTO fields are often
 * optional for backward compatibility, so a plain return type annotation or
 * `satisfies Destination` would not fail when a new optional field is added and
 * forgotten by the mapper. The paired checks below make every currently known
 * field an explicit decision: read it from the source, and either write it to
 * the destination or document why it is intentionally not persisted.
 */

function emptyLmParametersDto(): LmParametersDto {
  return {
    temperature: undefined,
    experimental: undefined,
    topP: undefined,
    maxCompletionTokens: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
    stop: undefined,
    reasoning: undefined,
  };
}

const titleModelToDomain = ({
  model,
}: {
  model: 'same_scope' | { id: string },
}): 'same_scope' | { id: string } => {
  if (model === 'same_scope') return 'same_scope';

  const { id, ...unhandled } = model;
  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<{ id: string }>()({ id });
};


const explicitTitleModelToDomain = ({
  model,
}: {
  model: { id: string },
}): { id: string } => {
  const { id, ...unhandled } = model;
  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<{ id: string }>()({ id });
};

const modelFromLegacyTitleModelId = ({
  titleModelId,
}: {
  titleModelId: string | undefined,
}): 'same_scope' | { id: string } => titleModelId === undefined
  ? 'same_scope'
  : exactObject<{ id: string }>()({ id: titleModelId });

const titleLmParametersToDomain = ({
  dto,
}: {
  dto: 'same_scope' | LmParametersDto,
}): 'same_scope' | LmParameters => {
  if (dto === 'same_scope') return 'same_scope';
  return lmParametersToDomain({ dto }) ?? EMPTY_LM_PARAMETERS;
};

const explicitTitleLmParametersToDomain = ({
  dto,
}: {
  dto: LmParametersDto,
}): LmParameters => lmParametersToDomain({ dto }) ?? EMPTY_LM_PARAMETERS;

const titleLmParametersToDto = ({
  lmParameters,
}: {
  lmParameters: 'same_scope' | LmParameters,
}): 'same_scope' | LmParametersDto => {
  if (lmParameters === 'same_scope') return 'same_scope';
  return lmParametersToDto({ domain: lmParameters }) ?? emptyLmParametersDto();
};

const explicitTitleLmParametersToDto = ({
  lmParameters,
}: {
  lmParameters: LmParameters,
}): LmParametersDto => lmParametersToDto({ domain: lmParameters }) ?? emptyLmParametersDto();

const settingsTitleGenerationToDomain = ({
  dto,
}: {
  dto: SettingsDto,
}): SettingsTitleGeneration => {
  if ('titleGeneration' in dto) {
    if (dto.titleGeneration === 'disabled') return 'disabled';

    const {
      endpoint,
      model,
      lmParameters,
      ...unhandled
    } = dto.titleGeneration;
    unhandled satisfies Record<PropertyKey, never>;

    if (endpoint === 'same_scope') {
      return exactObject<Extract<SettingsTitleGeneration, { endpoint: 'same_scope' }>>()({
        endpoint,
        model: titleModelToDomain({ model }),
        lmParameters: titleLmParametersToDomain({ dto: lmParameters }),
      });
    }

    return exactObject<Extract<SettingsTitleGeneration, { endpoint: Endpoint }>>()({
      endpoint: endpointToDomain({ dto: endpoint }),
      model: explicitTitleModelToDomain({ model }),
      lmParameters: explicitTitleLmParametersToDomain({ dto: lmParameters }),
    });
  }

  if (dto.autoTitleEnabled === false) return 'disabled';

  return exactObject<Exclude<SettingsTitleGeneration, 'disabled'>>()({
    endpoint: 'same_scope',
    model: modelFromLegacyTitleModelId({ titleModelId: dto.titleModelId }),
    lmParameters: EMPTY_LM_PARAMETERS,
  });
};

const scopedTitleGenerationToDomain = ({
  dto,
}: {
  dto: ChatGroupDto | ChatMetaDto | ChatDto,
}): ScopedTitleGeneration => {
  if ('titleGeneration' in dto) {
    switch (dto.titleGeneration) {
    case 'inherit':
    case 'disabled':
      return dto.titleGeneration;
    default: {
      const {
        endpoint,
        model,
        lmParameters,
        ...unhandled
      } = dto.titleGeneration;
      unhandled satisfies Record<PropertyKey, never>;

      if (endpoint === 'same_scope') {
        return exactObject<Extract<ScopedTitleGeneration, { endpoint: 'same_scope' }>>()({
          endpoint,
          model: titleModelToDomain({ model }),
          lmParameters: titleLmParametersToDomain({ dto: lmParameters }),
        });
      }

      return exactObject<Extract<ScopedTitleGeneration, { endpoint: Endpoint }>>()({
        endpoint: endpointToDomain({ dto: endpoint }),
        model: explicitTitleModelToDomain({ model }),
        lmParameters: explicitTitleLmParametersToDomain({ dto: lmParameters }),
      });
    }
    }
  }

  if (dto.autoTitleEnabled === false) return 'disabled';
  if (dto.autoTitleEnabled === undefined && dto.titleModelId === undefined) return 'inherit';

  return exactObject<Exclude<ScopedTitleGeneration, 'disabled' | 'inherit'>>()({
    endpoint: 'same_scope',
    model: modelFromLegacyTitleModelId({ titleModelId: dto.titleModelId }),
    lmParameters: EMPTY_LM_PARAMETERS,
  });
};

const settingsTitleGenerationToDto = ({
  titleGeneration,
}: {
  titleGeneration: SettingsTitleGeneration,
}): SettingsDtoV2['titleGeneration'] => {
  if (titleGeneration === 'disabled') return 'disabled';

  const {
    endpoint,
    model,
    lmParameters,
    ...unhandled
  } = titleGeneration;
  unhandled satisfies Record<PropertyKey, never>;

  if (endpoint === 'same_scope') {
    return exactObject<Extract<SettingsDtoV2['titleGeneration'], { endpoint: 'same_scope' }>>()({
      endpoint,
      model,
      lmParameters: titleLmParametersToDto({ lmParameters }),
    });
  }

  return exactObject<Exclude<Exclude<SettingsDtoV2['titleGeneration'], 'disabled'>, { endpoint: 'same_scope' }>>()({
    endpoint: endpointToDto({ endpoint }),
    model,
    lmParameters: explicitTitleLmParametersToDto({ lmParameters }),
  });
};

const scopedTitleGenerationToDto = ({
  titleGeneration,
}: {
  titleGeneration: ScopedTitleGeneration,
}): ChatMetaDtoV2['titleGeneration'] => {
  switch (titleGeneration) {
  case 'inherit':
  case 'disabled':
    return titleGeneration;
  default: {
    const {
      endpoint,
      model,
      lmParameters,
      ...unhandled
    } = titleGeneration;
    unhandled satisfies Record<PropertyKey, never>;

    if (endpoint === 'same_scope') {
      return exactObject<Extract<ChatMetaDtoV2['titleGeneration'], { endpoint: 'same_scope' }>>()({
        endpoint,
        model,
        lmParameters: titleLmParametersToDto({ lmParameters }),
      });
    }

    return exactObject<Exclude<Exclude<ChatMetaDtoV2['titleGeneration'], 'disabled' | 'inherit'>, { endpoint: 'same_scope' }>>()({
      endpoint: endpointToDto({ endpoint }),
      model,
      lmParameters: explicitTitleLmParametersToDto({ lmParameters }),
    });
  }
  }
};


const toolConfigPersistenceToExperimentalDto = ({
  persistence,
}: {
  persistence: ToolConfigPersistence | undefined,
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
  status: 'disabled' | 'enabled' | undefined,
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

const toolConfigToDomain = ({
  dto,
}: {
  dto: ExperimentalToolConfigDto,
}): ToolConfig => {
  switch (dto.key) {
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wikipedia':
    return {
      key: dto.key,
      status: dto.status,
    };
  case 'builtin.wesh':
    return {
      key: dto.key,
      status: dto.status,
      naidanSysfs: {
        accessScope: dto.naidanSysfs.accessScope,
      },
    };
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled tool config DTO: ${String(_ex)}`);
  }
  }
};

const toolConfigToDto = ({
  domain,
}: {
  domain: ToolConfig,
}): ExperimentalToolConfigDto => {
  switch (domain.key) {
  case 'builtin.calculator':
  case 'builtin.choices':
  case 'builtin.wikipedia':
    return {
      key: domain.key,
      status: domain.status,
    };
  case 'builtin.wesh':
    return {
      key: domain.key,
      status: domain.status,
      naidanSysfs: {
        accessScope: domain.naidanSysfs.accessScope,
      },
    };
  default: {
    const _ex: never = domain;
    throw new Error(`Unhandled tool config domain: ${String(_ex)}`);
  }
  }
};

const toolConfigsToDomain = ({
  toolConfigs,
}: {
  toolConfigs: ExperimentalToolConfigsDto | undefined,
}): ToolConfig[] | undefined => toolConfigs?.map(dto => toolConfigToDomain({ dto }));

const toolConfigsToExperimentalDto = ({
  toolConfigs,
}: {
  toolConfigs: ToolConfig[] | undefined,
}): { toolConfigs: ExperimentalToolConfigsDto | undefined } | undefined => {
  return toolConfigs === undefined
    ? undefined
    : { toolConfigs: toolConfigs.map(domain => toolConfigToDto({ domain })) };
};

const mountToDomain = ({ dto }: { dto: MountDto }): Mount => {
  const type = dto.type;
  switch (type) {
  case 'volume': {
    const {
      type,
      experimental: _experimental,
      volumeId,
      mountPath,
      readOnly,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Mount>()({
      type,
      volumeId: toVolumeId({ raw: volumeId }),
      mountPath,
      readOnly,
    });
  }
  default: {
    const _ex: never = type;
    throw new Error(`Unhandled mount type: ${_ex}`);
  }
  }
};

const mountToDto = ({ domain }: { domain: Mount }): MountDto => {
  const type = domain.type;
  switch (type) {
  case 'volume': {
    const {
      type,
      volumeId,
      mountPath,
      readOnly,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<MountDto>()({
      type,
      experimental: undefined,
      volumeId: idToRaw({ id: volumeId }),
      mountPath,
      readOnly,
    });
  }
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

export const chatMetaToDomain = ({ dto }: { dto: ChatMetaDto }): ChatMeta => {
  const titleGeneration = scopedTitleGenerationToDomain({ dto });

  const {
    id,
    experimental,
    title,
    currentLeafId,
    updatedAt,
    createdAt,
    debugEnabled,
    endpoint,
    modelId,
    titleGeneration: _titleGeneration,
    autoTitleEnabled: _legacyAutoTitleEnabled,
    titleModelId: _legacyTitleModelId,
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters,
    mounts,
    ...unhandled
  } = dto as ChatMetaDto & {
    titleGeneration?: ChatMetaDtoV2['titleGeneration'],
    autoTitleEnabled?: boolean,
    titleModelId?: string,
  };

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatMeta>()({
    id: toChatId({ raw: id }),
    title,
    groupId: undefined,
    currentLeafId: currentLeafId === undefined ? undefined : toMessageId({ raw: currentLeafId }),
    createdAt,
    updatedAt,
    debugEnabled,
    endpoint: endpoint === undefined
      ? undefined
      : endpointToDomain({ dto: endpoint }),
    modelId,
    titleGeneration,
    originChatId: originChatId === undefined ? undefined : toChatId({ raw: originChatId }),
    originMessageId: originMessageId === undefined ? undefined : toMessageId({ raw: originMessageId }),
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters: lmParametersToDomain({ dto: lmParameters }),
    mounts: mounts?.map(dto => mountToDomain({ dto })),
    toolConfigs: toolConfigsToDomain({ toolConfigs: experimental?.toolConfigs }),
  });
};

/**
 * Converts a Chat Group DTO into a Domain ChatGroup.
 * Resolves nested items using the hierarchy and provided chat metadata.
 */
export const chatGroupToDomain = (
  { dto, hierarchy, chatMetas }: { dto: ChatGroupDto, hierarchy: Hierarchy, chatMetas: ChatMeta[] },
): ChatGroup => {
  const node = hierarchy.items.find(
    i => i.type === 'chat_group' && i.id === toChatGroupId({ raw: dto.id }),
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
        groupId: toChatGroupId({ raw: dto.id }),
      },
    };
  });

  const titleGeneration = scopedTitleGenerationToDomain({ dto });

  const {
    id,
    experimental,
    name,
    updatedAt,
    isCollapsed,
    endpoint,
    modelId,
    titleGeneration: _titleGeneration,
    autoTitleEnabled: _legacyAutoTitleEnabled,
    titleModelId: _legacyTitleModelId,
    systemPrompt,
    lmParameters,
    mounts,
    ...unhandled
  } = dto as ChatGroupDto & {
    titleGeneration?: ChatGroupDtoV2['titleGeneration'],
    autoTitleEnabled?: boolean,
    titleModelId?: string,
  };

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatGroup>()({
    id: toChatGroupId({ raw: id }),
    name,
    isCollapsed,
    items,
    updatedAt,
    endpoint: endpoint === undefined
      ? undefined
      : endpointToDomain({ dto: endpoint }),
    modelId,
    titleGeneration,
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters: lmParametersToDomain({ dto: lmParameters }),
    mounts: mounts?.map(dto => mountToDomain({ dto })),
    toolConfigs: toolConfigsToDomain({ toolConfigs: experimental?.toolConfigs }),
  });
};

export const chatGroupToDto = ({ domain }: { domain: ChatGroup }): ChatGroupDto => {
  const {
    id,
    name,
    isCollapsed,
    items: _items,
    updatedAt,
    endpoint,
    modelId,
    titleGeneration,
    systemPrompt,
    lmParameters,
    mounts,
    toolConfigs,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatGroupDtoV2>()({
    id: idToRaw({ id }),
    experimental: toolConfigsToExperimentalDto({ toolConfigs }),
    name,
    updatedAt,
    isCollapsed,
    endpoint: endpoint ? endpointToDto({ endpoint }) : undefined,
    modelId,
    titleGeneration: scopedTitleGenerationToDto({
      titleGeneration: titleGeneration ?? 'inherit',
    }),
    systemPrompt,
    lmParameters: lmParametersToDto({ domain: lmParameters }),
    mounts: mounts?.map(domain => mountToDto({ domain })),
  });
};

export const lmParametersToDomain = (
  { dto }: { dto: LmParametersDto | undefined },
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
  { domain }: { domain: LmParameters | undefined },
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

export const endpointToDomain = ({ dto }: { dto: EndpointDto }): Endpoint => {
  switch (dto.type) {
  case 'openai':
  case 'ollama': {
    const {
      type,
      experimental: _experimental,
      url,
      httpHeaders,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<Endpoint, { type: 'openai' | 'ollama' }>>()({
      type,
      url,
      httpHeaders: httpHeaders?.map(([name, value]): [string, string] => [name, value]),
    });
  }
  case 'transformers_js': {
    const {
      type,
      experimental: _experimental,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<Endpoint, { type: 'transformers_js' }>>()({ type });
  }
  case 'experimental_type': {
    const {
      type: _type,
      experimental,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    const experimentalType = experimental?.type;
    switch (experimentalType) {
    case 'browser_provided_lm':
      return exactObject<Extract<Endpoint, { type: 'browser_provided_lm' }>>()({ type: 'browser_provided_lm' });
    case undefined: {
      const unreadableType = experimental?.unreadable?.type;
      return exactObject<Extract<Endpoint, { type: 'unsupported_experimental_endpoint' }>>()({
        type: 'unsupported_experimental_endpoint',
        persistedType: typeof unreadableType === 'string'
          ? unreadableType
          : undefined,
      });
    }
    default: {
      const _ex: never = experimentalType;
      throw new Error(`Unhandled experimental endpoint type: ${String(_ex)}`);
    }
    }
  }
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled endpoint DTO: ${String(_ex)}`);
  }
  }
};

export const endpointToDto = ({ endpoint }: { endpoint: Endpoint }): EndpointDto => {
  switch (endpoint.type) {
  case 'openai':
  case 'ollama': {
    const {
      type,
      url,
      httpHeaders,
      ...unhandled
    } = endpoint;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<EndpointDto, { type: 'openai' | 'ollama' }>>()({
      type,
      experimental: undefined,
      url,
      httpHeaders: httpHeaders?.map(([name, value]): [string, string] => [name, value]),
    });
  }
  case 'transformers_js': {
    const {
      type,
      ...unhandled
    } = endpoint;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<EndpointDto, { type: 'transformers_js' }>>()({
      type,
      experimental: undefined,
    });
  }
  case 'browser_provided_lm': {
    const {
      type: _type,
      ...unhandled
    } = endpoint;

    unhandled satisfies Record<PropertyKey, never>;

    const experimental = exactObject<NonNullable<Extract<EndpointDto, { type: 'experimental_type' }>['experimental']>>()({
      type: 'browser_provided_lm',
      unreadable: undefined,
    });

    return exactObject<Extract<EndpointDto, { type: 'experimental_type' }>>()({
      type: 'experimental_type',
      experimental,
    });
  }
  case 'unsupported_experimental_endpoint': {
    const {
      type: _type,
      persistedType: _persistedType,
      ...unhandled
    } = endpoint;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<EndpointDto, { type: 'experimental_type' }>>()({
      type: 'experimental_type',
      experimental: undefined,
    });
  }
  default: {
    const _ex: never = endpoint;
    throw new Error(`Unhandled endpoint: ${String(_ex)}`);
  }
  }
};

type AttachmentDtoV2 = Extract<AttachmentDto, { binaryObjectId: string }>;

const attachmentToDomain = ({ dto }: { dto: AttachmentDto }): Attachment => {
  if ('binaryObjectId' in dto) {
    // V2
    const {
      id,
      experimental: _experimental,
      binaryObjectId,
      name,
      status,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    const base = {
      id: toAttachmentId({ raw: id }),
      binaryObjectId: toBinaryObjectId({ raw: binaryObjectId }),
      originalName: name,
      // Metadata will be hydrated by the StorageProvider
      mimeType: 'application/octet-stream',
      size: 0,
      uploadedAt: Date.now(),
    };

    switch (status) {
    case 'persisted':
      return exactObject<Extract<Attachment, { status: 'persisted' }>>()({ ...base, status });
    case 'missing':
      return exactObject<Extract<Attachment, { status: 'missing' }>>()({ ...base, status });
    case 'memory':
      // Persisted V2 memory attachments can be reconstructed only as metadata here;
      // the provider may reattach the in-memory blob from its separate blob cache.
      return { ...base, status } as unknown as Attachment;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled attachment status: ${_ex}`);
    }
    }
  } else {
    // V1 (Legacy)
    const {
      id,
      experimental: _experimental,
      originalName,
      mimeType,
      size,
      uploadedAt,
      status,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    const base = {
      id: toAttachmentId({ raw: id }),
      binaryObjectId: toBinaryObjectId({ raw: id }), // Legacy use id as binaryObjectId
      originalName,
      mimeType,
      size,
      uploadedAt,
    };

    switch (status) {
    case 'persisted':
      return exactObject<Extract<Attachment, { status: 'persisted' }>>()({ ...base, status });
    case 'missing':
      return exactObject<Extract<Attachment, { status: 'missing' }>>()({ ...base, status });
    case 'memory':
      // Legacy memory attachments likewise depend on the provider blob cache.
      return { ...base, status } as unknown as Attachment;
    default: {
      const _ex: never = status;
      throw new Error(`Unhandled attachment status: ${_ex}`);
    }
    }
  }
};

const attachmentToDto = ({ domain }: { domain: Attachment }): AttachmentDto => {
  const toDto = ({ id, binaryObjectId, originalName, status }: {
    id: Attachment['id'],
    binaryObjectId: Attachment['binaryObjectId'],
    originalName: string,
    status: Attachment['status'],
  }): AttachmentDtoV2 => exactObject<AttachmentDtoV2>()({
    id: idToRaw({ id }),
    experimental: undefined,
    binaryObjectId: idToRaw({ id: binaryObjectId }),
    name: originalName,
    status,
  });

  switch (domain.status) {
  case 'persisted':
  case 'missing': {
    const {
      id,
      binaryObjectId,
      originalName,
      mimeType: _mimeType,
      size: _size,
      uploadedAt: _uploadedAt,
      status,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return toDto({ id, binaryObjectId, originalName, status });
  }
  case 'memory': {
    const {
      id,
      binaryObjectId,
      originalName,
      mimeType: _mimeType,
      size: _size,
      uploadedAt: _uploadedAt,
      status,
      blob: _blob,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return toDto({ id, binaryObjectId, originalName, status });
  }
  default: {
    const _ex: never = domain;
    throw new Error(`Unhandled attachment status: ${(_ex as { status: string }).status}`);
  }
  }
};

const toolCallToDomain = ({ dto }: { dto: ToolCallDto }): ToolCall => {
  const {
    id,
    experimental: _experimental,
    type,
    function: functionDto,
    ...unhandled
  } = dto;

  unhandled satisfies Record<PropertyKey, never>;

  const {
    name,
    experimental: _functionExperimental,
    arguments: rawArguments,
    ...unhandledFunction
  } = functionDto;

  unhandledFunction satisfies Record<PropertyKey, never>;

  return exactObject<ToolCall>()({
    id: toToolCallId({ raw: id }),
    type,
    function: exactObject<ToolCall['function']>()({
      name,
      arguments: rawArguments,
    }),
  });
};

const toolCallToDto = ({ domain }: { domain: ToolCall }): ToolCallDto => {
  const {
    id,
    type,
    function: functionDomain,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  const {
    name,
    arguments: rawArguments,
    ...unhandledFunction
  } = functionDomain;

  unhandledFunction satisfies Record<PropertyKey, never>;

  return exactObject<ToolCallDto>()({
    id: idToRaw({ id }),
    experimental: undefined,
    type,
    function: exactObject<ToolCallDto['function']>()({
      name,
      experimental: undefined,
      arguments: rawArguments,
    }),
  });
};

const textOrBinaryObjectToDomain = ({ dto }: { dto: TextOrBinaryObjectDto }): TextOrBinaryObject => {
  switch (dto.type) {
  case 'text': {
    const {
      type,
      text,
      experimental: _experimental,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<TextOrBinaryObject, { type: 'text' }>>()({ type, text });
  }
  case 'binary_object': {
    const {
      type,
      id,
      experimental: _experimental,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<TextOrBinaryObject, { type: 'binary_object' }>>()({
      type,
      id: toBinaryObjectId({ raw: id }),
    });
  }
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled text or binary object DTO: ${(_ex as { type: string }).type}`);
  }
  }
};

const textOrBinaryObjectToDto = ({ domain }: { domain: TextOrBinaryObject }): TextOrBinaryObjectDto => {
  switch (domain.type) {
  case 'text': {
    const {
      type,
      text,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<TextOrBinaryObjectDto, { type: 'text' }>>()({
      type,
      experimental: undefined,
      text,
    });
  }
  case 'binary_object': {
    const {
      type,
      id,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<TextOrBinaryObjectDto, { type: 'binary_object' }>>()({
      type,
      experimental: undefined,
      id: idToRaw({ id }),
    });
  }
  default: {
    const _ex: never = domain;
    throw new Error(`Unhandled text or binary object: ${(_ex as { type: string }).type}`);
  }
  }
};

const toolExecutionResultToDomain = ({ dto }: { dto: ToolExecutionResultDto }): ToolExecutionResult => {
  switch (dto.status) {
  case 'executing': {
    const {
      toolCallId,
      status,
      experimental: _experimental,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<ToolExecutionResult, { status: 'executing' }>>()({
      toolCallId: toToolCallId({ raw: toolCallId }),
      status,
    });
  }
  case 'success': {
    const {
      toolCallId,
      status,
      experimental: _experimental,
      content,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<ToolExecutionResult, { status: 'success' }>>()({
      toolCallId: toToolCallId({ raw: toolCallId }),
      status,
      content: textOrBinaryObjectToDomain({ dto: content }),
    });
  }
  case 'error': {
    const {
      toolCallId,
      status,
      experimental: _experimental,
      error,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    const {
      code,
      experimental: _errorExperimental,
      message,
      ...unhandledError
    } = error;

    unhandledError satisfies Record<PropertyKey, never>;

    return exactObject<Extract<ToolExecutionResult, { status: 'error' }>>()({
      toolCallId: toToolCallId({ raw: toolCallId }),
      status,
      error: exactObject<Extract<ToolExecutionResult, { status: 'error' }>['error']>()({
        code,
        message: textOrBinaryObjectToDomain({ dto: message }),
      }),
    });
  }
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled tool execution result status: ${(_ex as { status: string }).status}`);
  }
  }
};

const toolExecutionResultToDto = ({ domain }: { domain: ToolExecutionResult }): ToolExecutionResultDto => {
  switch (domain.status) {
  case 'executing': {
    const {
      toolCallId,
      status,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<ToolExecutionResultDto, { status: 'executing' }>>()({
      toolCallId: idToRaw({ id: toolCallId }),
      status,
      experimental: undefined,
    });
  }
  case 'success': {
    const {
      toolCallId,
      status,
      content,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<ToolExecutionResultDto, { status: 'success' }>>()({
      toolCallId: idToRaw({ id: toolCallId }),
      status,
      experimental: undefined,
      content: textOrBinaryObjectToDto({ domain: content }),
    });
  }
  case 'error': {
    const {
      toolCallId,
      status,
      error,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    const {
      code,
      message,
      ...unhandledError
    } = error;

    unhandledError satisfies Record<PropertyKey, never>;

    return exactObject<Extract<ToolExecutionResultDto, { status: 'error' }>>()({
      toolCallId: idToRaw({ id: toolCallId }),
      status,
      experimental: undefined,
      error: exactObject<Extract<ToolExecutionResultDto, { status: 'error' }>['error']>()({
        code,
        experimental: undefined,
        message: textOrBinaryObjectToDto({ domain: message }),
      }),
    });
  }
  default: {
    const _ex: never = domain;
    throw new Error(`Unhandled tool execution result status: ${(_ex as { status: string }).status}`);
  }
  }
};

const messageNodeRepliesToDomain = ({ replies }: { replies: MessageNodeDto['replies'] }): MessageBranch => {
  const {
    items,
    ...unhandled
  } = replies;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<MessageBranch>()({
    items: items.map(dto => messageNodeToDomain({ dto })),
  });
};

const messageNodeRepliesToDto = ({ replies }: { replies: MessageBranch }): MessageNodeDto['replies'] => {
  const {
    items,
    ...unhandled
  } = replies;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<MessageNodeDto['replies']>()({
    items: items.map(domain => messageNodeToDto({ domain })),
  });
};

export const messageNodeToDomain = ({ dto }: { dto: MessageNodeDto }): MessageNode => {
  switch (dto.role) {
  case 'user': {
    const {
      id,
      role,
      content,
      attachments,
      timestamp,
      thinking: _thinking,
      modelId: _modelId,
      lmParameters,
      toolCalls: _toolCalls,
      results: _results,
      replies,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<UserMessageNode>()({
      id: toMessageId({ raw: id }),
      role,
      content,
      attachments: attachments?.map(dto => attachmentToDomain({ dto })),
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: lmParametersToDomain({ dto: lmParameters }),
      toolCalls: undefined,
      results: undefined,
      timestamp,
      replies: messageNodeRepliesToDomain({ replies }),
    });
  }
  case 'assistant': {
    const {
      id,
      role,
      content,
      attachments: _attachments,
      timestamp,
      thinking,
      modelId,
      lmParameters,
      toolCalls,
      results: _results,
      replies,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<AssistantMessageNode>()({
      id: toMessageId({ raw: id }),
      role,
      content,
      attachments: undefined,
      thinking,
      error: undefined,
      modelId,
      lmParameters: lmParametersToDomain({ dto: lmParameters }),
      toolCalls: toolCalls?.map(dto => toolCallToDomain({ dto })),
      results: undefined,
      timestamp,
      replies: messageNodeRepliesToDomain({ replies }),
    });
  }
  case 'system': {
    const {
      id,
      role,
      content,
      attachments: _attachments,
      timestamp,
      thinking: _thinking,
      modelId: _modelId,
      lmParameters: _lmParameters,
      toolCalls: _toolCalls,
      results: _results,
      replies,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<SystemMessageNode>()({
      id: toMessageId({ raw: id }),
      role,
      content,
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
      timestamp,
      replies: messageNodeRepliesToDomain({ replies }),
    });
  }
  case 'tool': {
    const {
      id,
      role,
      content: _content,
      attachments: _attachments,
      timestamp,
      thinking: _thinking,
      modelId: _modelId,
      lmParameters: _lmParameters,
      toolCalls: _toolCalls,
      results,
      replies,
      ...unhandled
    } = dto;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<ToolMessageNode>()({
      id: toMessageId({ raw: id }),
      role,
      content: undefined,
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: results.map(dto => toolExecutionResultToDomain({ dto })),
      timestamp,
      replies: messageNodeRepliesToDomain({ replies }),
    });
  }
  default: {
    const _ex: never = dto;
    throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
  }
  }
};

export const messageNodeToDto = ({ domain }: { domain: MessageNode }): MessageNodeDto => {
  switch (domain.role) {
  case 'user': {
    const {
      id,
      role,
      content,
      attachments,
      thinking: _thinking,
      error: _error,
      modelId: _modelId,
      lmParameters,
      toolCalls: _toolCalls,
      results: _results,
      timestamp,
      replies,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<MessageNodeDto, { role: 'user' }>>()({
      id: idToRaw({ id }),
      role,
      content,
      attachments: attachments?.map(domain => attachmentToDto({ domain })),
      thinking: undefined,
      modelId: undefined,
      lmParameters: lmParametersToDto({ domain: lmParameters }),
      toolCalls: undefined,
      results: undefined,
      timestamp,
      replies: messageNodeRepliesToDto({ replies }),
    });
  }
  case 'assistant': {
    const {
      id,
      role,
      content,
      attachments: _attachments,
      thinking,
      error: _error,
      modelId,
      lmParameters,
      toolCalls,
      results: _results,
      timestamp,
      replies,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<MessageNodeDto, { role: 'assistant' }>>()({
      id: idToRaw({ id }),
      role,
      content,
      attachments: undefined,
      thinking,
      modelId,
      lmParameters: lmParametersToDto({ domain: lmParameters }),
      toolCalls: toolCalls?.map(domain => toolCallToDto({ domain })),
      results: undefined,
      timestamp,
      replies: messageNodeRepliesToDto({ replies }),
    });
  }
  case 'system': {
    const {
      id,
      role,
      content,
      attachments: _attachments,
      thinking: _thinking,
      error: _error,
      modelId: _modelId,
      lmParameters: _lmParameters,
      toolCalls: _toolCalls,
      results: _results,
      timestamp,
      replies,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<MessageNodeDto, { role: 'system' }>>()({
      id: idToRaw({ id }),
      role,
      content,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
      timestamp,
      replies: messageNodeRepliesToDto({ replies }),
    });
  }
  case 'tool': {
    const {
      id,
      role,
      content: _content,
      attachments: _attachments,
      thinking: _thinking,
      error: _error,
      modelId: _modelId,
      lmParameters: _lmParameters,
      toolCalls: _toolCalls,
      results,
      timestamp,
      replies,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<MessageNodeDto, { role: 'tool' }>>()({
      id: idToRaw({ id }),
      role,
      content: undefined,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: results.map(domain => toolExecutionResultToDto({ domain })),
      timestamp,
      replies: messageNodeRepliesToDto({ replies }),
    });
  }
  default: {
    const _ex: never = domain;
    throw new Error(`Unhandled role: ${(_ex as { role: string }).role}`);
  }
  }
};

interface LegacyMessage {
  id: string,
  role: Role,
  content: string,
  timestamp: number,
  thinking?: string,
  modelId?: string,
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
          reasoning: { effort: undefined },
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
          reasoning: { effort: undefined },
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
  const titleGeneration = scopedTitleGenerationToDomain({ dto });

  const {
    id,
    experimental,
    title,
    currentLeafId,
    updatedAt,
    createdAt,
    debugEnabled,
    endpoint,
    modelId,
    titleGeneration: _titleGeneration,
    autoTitleEnabled: _legacyAutoTitleEnabled,
    titleModelId: _legacyTitleModelId,
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters,
    mounts,
    root: dtoRoot,
    messages,
    ...unhandled
  } = dto as ChatDto & {
    titleGeneration?: ChatDtoV2['titleGeneration'],
    autoTitleEnabled?: boolean,
    titleModelId?: string,
  };

  unhandled satisfies Record<PropertyKey, never>;

  let root: MessageBranch = { items: [] };

  if (dtoRoot && dtoRoot.items && dtoRoot.items.length > 0) {
    root = exactObject<MessageBranch>()({ items: (dtoRoot.items as MessageNodeDto[]).map(dto => messageNodeToDomain({ dto })) });
  } else if (messages && messages.length > 0) {
    // Priority to legacy flat messages if tree is empty
    root = migrateFlatMessagesToTree({ messages });
  } else if (dtoRoot && !('items' in dtoRoot)) {
    // Handle edge case where root might be a single node
    root = exactObject<MessageBranch>()({ items: [messageNodeToDomain({ dto: dtoRoot as MessageNodeDto })] });
  }

  return exactObject<Chat>()({
    id: toChatId({ raw: id }),
    title,
    groupId: undefined,
    root,
    currentLeafId: currentLeafId === undefined ? undefined : toMessageId({ raw: currentLeafId }),
    createdAt,
    updatedAt,
    debugEnabled: debugEnabled ?? false,
    endpoint: endpoint === undefined ? undefined : endpointToDomain({ dto: endpoint }),
    modelId,
    titleGeneration,
    originChatId: originChatId === undefined ? undefined : toChatId({ raw: originChatId }),
    originMessageId: originMessageId === undefined ? undefined : toMessageId({ raw: originMessageId }),
    systemPrompt: systemPrompt as SystemPrompt | undefined,
    lmParameters: lmParametersToDomain({ dto: lmParameters }),
    mounts: mounts?.map(dto => mountToDomain({ dto })),
    toolConfigs: toolConfigsToDomain({ toolConfigs: experimental?.toolConfigs }),
  });
};

export const chatMetaToSummary = ({ domain }: { domain: ChatMeta }): ChatSummary => {
  const {
    id,
    title,
    groupId,
    currentLeafId: _currentLeafId,
    createdAt: _createdAt,
    updatedAt,
    debugEnabled: _debugEnabled,
    endpoint: _endpoint,
    modelId: _modelId,
    titleGeneration: _titleGeneration,
    originChatId: _originChatId,
    originMessageId: _originMessageId,
    systemPrompt: _systemPrompt,
    lmParameters: _lmParameters,
    mounts: _mounts,
    toolConfigs: _toolConfigs,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatSummary>()({
    id,
    title,
    updatedAt,
    groupId,
  });
};

export const chatMetaToDto = ({ domain }: { domain: ChatMeta }): ChatMetaDto => {
  const {
    id,
    title,
    groupId: _groupId,
    currentLeafId,
    createdAt,
    updatedAt,
    debugEnabled,
    endpoint,
    modelId,
    titleGeneration,
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters,
    mounts,
    toolConfigs,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatMetaDtoV2>()({
    id: idToRaw({ id }),
    experimental: toolConfigsToExperimentalDto({ toolConfigs }),
    title,
    currentLeafId: currentLeafId === undefined ? undefined : idToRaw({ id: currentLeafId }),
    updatedAt,
    createdAt,
    debugEnabled,
    endpoint: endpoint ? endpointToDto({ endpoint }) : undefined,
    modelId,
    titleGeneration: scopedTitleGenerationToDto({
      titleGeneration: titleGeneration ?? 'inherit',
    }),
    originChatId: originChatId === undefined ? undefined : idToRaw({ id: originChatId }),
    originMessageId: originMessageId === undefined ? undefined : idToRaw({ id: originMessageId }),
    systemPrompt,
    lmParameters: lmParametersToDto({ domain: lmParameters }),
    mounts: mounts?.map(domain => mountToDto({ domain })),
  });
};

export const chatContentToDto = ({ domain }: { domain: ChatContent }): ChatContentDto => {
  const {
    root,
    currentLeafId,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatContentDto>()({
    root: exactObject<ChatContentDto['root']>()({
      items: root.items.map(domain => messageNodeToDto({ domain })),
      experimental: undefined,
    }),
    experimental: undefined,
    currentLeafId: currentLeafId === undefined ? undefined : idToRaw({ id: currentLeafId }),
  });
};

export const chatContentToDomain = ({ dto }: { dto: ChatContentDto }): ChatContent => {
  const {
    root,
    experimental: _experimental,
    currentLeafId,
    ...unhandled
  } = dto;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatContent>()({
    root: exactObject<MessageBranch>()({
      items: root.items.map(dto => messageNodeToDomain({ dto })),
    }),
    currentLeafId: currentLeafId === undefined ? undefined : toMessageId({ raw: currentLeafId }),
  });
};

export const chatToDto = ({ domain }: { domain: Chat }): ChatDto => {
  const {
    id,
    title,
    groupId: _groupId,
    root,
    currentLeafId,
    createdAt,
    updatedAt,
    debugEnabled,
    endpoint,
    modelId,
    titleGeneration,
    originChatId,
    originMessageId,
    systemPrompt,
    lmParameters,
    mounts,
    toolConfigs,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<ChatDtoV2>()({
    id: idToRaw({ id }),
    experimental: toolConfigsToExperimentalDto({ toolConfigs }),
    title,
    currentLeafId: currentLeafId === undefined ? undefined : idToRaw({ id: currentLeafId }),
    updatedAt,
    createdAt,
    debugEnabled,
    endpoint: endpoint === undefined ? undefined : endpointToDto({ endpoint }),
    modelId,
    titleGeneration: scopedTitleGenerationToDto({
      titleGeneration: titleGeneration ?? 'inherit',
    }),
    originChatId: originChatId === undefined ? undefined : idToRaw({ id: originChatId }),
    originMessageId: originMessageId === undefined ? undefined : idToRaw({ id: originMessageId }),
    systemPrompt,
    lmParameters: lmParametersToDto({ domain: lmParameters }),
    mounts: mounts?.map(domain => mountToDto({ domain })),
    root: exactObject<NonNullable<ChatDto['root']>>()({
      items: root.items.map(domain => messageNodeToDto({ domain })),
      experimental: undefined,
    }),
    messages: undefined,
  });
};

/**
 * High-level Sidebar assembly mapper.
 * Uses Hierarchy as the structural template.
 */
export const buildSidebarItemsFromHierarchy = (
  { hierarchy, chatMetas, chatGroups }: { hierarchy: Hierarchy, chatMetas: ChatMeta[], chatGroups: Omit<ChatGroup, 'items'>[] },
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
        chat: { ...chatMetaToSummary({ domain: meta }), groupId: null },
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
            chat: { ...chatMetaToSummary({ domain: m }), groupId: groupMeta.id },
          } as ChatSidebarItem;
        })
        .filter((i): i is ChatSidebarItem => i !== null);

      return {
        id: `chat_group:${idToRaw({ id: node.id })}`,
        type: 'chat_group',
        chatGroup: { ...groupMeta, items: nestedItems },
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
  const titleGeneration = settingsTitleGenerationToDomain({ dto });

  const {
    endpoint,
    defaultModelId,
    titleGeneration: _titleGeneration,
    titleModelId: _legacyTitleModelId,
    autoTitleEnabled: _legacyAutoTitleEnabled,
    storageType,
    providerProfiles,
    mounts,
    heavyContentAlertDismissed,
    systemPrompt,
    lmParameters,
    experimental,
    ...unhandled
  } = dto as SettingsDto & {
    titleGeneration?: SettingsDtoV2['titleGeneration'],
    titleModelId?: string,
    autoTitleEnabled?: boolean,
  };

  unhandled satisfies Record<PropertyKey, never>;

  const experimentalDomain = (() => {
    const {
      locale,
      markdownRendering,
      toolConfigPersistence,
      toolConfigs,
      fakeLm,
      sidebarSendMessageReorder,
      globalSearch,
      unreadable,
      ...unhandledExperimental
    } = experimental ?? {};

    unhandledExperimental satisfies Record<PropertyKey, never>;

    const globalSearchDomain = (() => {
      if (globalSearch === undefined) return undefined;

      const {
        scope,
        roleFilter,
        previewMode,
        previewContextSize,
        ...unhandledGlobalSearch
      } = globalSearch;

      unhandledGlobalSearch satisfies Record<PropertyKey, never>;

      return exactObject<NonNullable<NonNullable<Settings['experimental']>['globalSearch']>>()({
        scope,
        roleFilter,
        previewMode,
        previewContextSize,
      });
    })();

    return exactObject<NonNullable<Settings['experimental']>>()({
      locale,
      markdownRendering,
      toolConfigPersistence: toolConfigPersistence ?? 'disabled',
      toolConfigs: toolConfigsToDomain({ toolConfigs }),
      fakeLm: fakeLm ?? 'disabled',
      sidebarSendMessageReorder: sidebarSendMessageReorder ?? 'disabled',
      globalSearch: globalSearchDomain,
      unreadable,
    });
  })();

  const profileDomains = providerProfiles.map(profile => {
    const {
      id,
      experimental: _experimental,
      name,
      endpoint,
      defaultModelId,
      titleModelId,
      systemPrompt,
      lmParameters,
      ...unhandledProfile
    } = profile;

    unhandledProfile satisfies Record<PropertyKey, never>;

    return exactObject<Settings['providerProfiles'][number]>()({
      id: toProviderProfileId({ raw: id }),
      name,
      endpoint: endpointToDomain({ dto: endpoint }),
      defaultModelId,
      titleModelId,
      systemPrompt,
      lmParameters: lmParametersToDomain({ dto: lmParameters }),
    });
  });

  return exactObject<Settings>()({
    endpoint: endpointToDomain({ dto: endpoint }),
    defaultModelId,
    titleGeneration,
    storageType: storageType as StorageType,
    providerProfiles: profileDomains,
    mounts: mounts.map(dto => mountToDomain({ dto })),
    heavyContentAlertDismissed,
    systemPrompt,
    lmParameters: lmParametersToDomain({ dto: lmParameters }),
    experimental: experimentalDomain,
  });
};

export const settingsToDto = ({ domain }: { domain: Settings }): SettingsDto => {
  const {
    endpoint,
    defaultModelId,
    titleGeneration,
    storageType,
    providerProfiles,
    mounts,
    heavyContentAlertDismissed,
    systemPrompt,
    lmParameters,
    experimental,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  const experimentalDto = (() => {
    const {
      locale,
      markdownRendering,
      toolConfigPersistence,
      toolConfigs,
      fakeLm,
      sidebarSendMessageReorder,
      globalSearch,
      unreadable: _unreadable,
      ...unhandledExperimental
    } = experimental ?? {};

    unhandledExperimental satisfies Record<PropertyKey, never>;

    const globalSearchDto = (() => {
      if (globalSearch === undefined) return undefined;

      const {
        scope,
        roleFilter,
        previewMode,
        previewContextSize,
        ...unhandledGlobalSearch
      } = globalSearch;

      unhandledGlobalSearch satisfies Record<PropertyKey, never>;

      return exactObject<NonNullable<NonNullable<SettingsDto['experimental']>['globalSearch']>>()({
        scope,
        roleFilter,
        previewMode,
        previewContextSize,
      });
    })();

    return exactObject<NonNullable<SettingsDto['experimental']>>()({
      locale,
      markdownRendering,
      toolConfigPersistence: toolConfigPersistenceToExperimentalDto({
        persistence: toolConfigPersistence,
      }),
      toolConfigs: toolConfigs?.map(domain => toolConfigToDto({ domain })),
      fakeLm: fakeLmToExperimentalDto({
        status: fakeLm,
      }),
      sidebarSendMessageReorder: sidebarSendMessageReorder ?? 'disabled',
      globalSearch: globalSearchDto,
      unreadable: undefined,
    });
  })();

  const profileDtos = (providerProfiles ?? []).map(profile => {
    const {
      id,
      name,
      endpoint,
      defaultModelId,
      titleModelId,
      systemPrompt,
      lmParameters,
      ...unhandledProfile
    } = profile;

    unhandledProfile satisfies Record<PropertyKey, never>;

    return exactObject<SettingsDto['providerProfiles'][number]>()({
      id: idToRaw({ id }),
      experimental: undefined,
      name,
      endpoint: endpointToDto({ endpoint }),
      defaultModelId,
      titleModelId,
      systemPrompt,
      lmParameters: lmParametersToDto({ domain: lmParameters }),
    });
  });

  return exactObject<SettingsDtoV2>()({
    endpoint: endpointToDto({ endpoint }),
    defaultModelId,
    titleGeneration: settingsTitleGenerationToDto({ titleGeneration }),
    storageType: storageType as StorageTypeDto,
    providerProfiles: profileDtos,
    mounts: (mounts ?? []).map(domain => mountToDto({ domain })),
    heavyContentAlertDismissed,
    systemPrompt,
    lmParameters: lmParametersToDto({ domain: lmParameters }),
    experimental: experimentalDto,
  });
};

export const binaryObjectToDomain = ({ dto }: { dto: BinaryObjectDto }): BinaryObject => {
  const {
    id,
    experimental: _experimental,
    mimeType,
    size,
    createdAt,
    name,
    ...unhandled
  } = dto;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<BinaryObject>()({
    id: toBinaryObjectId({ raw: id }),
    mimeType,
    size,
    createdAt,
    name,
  });
};

export const binaryObjectToDto = ({ domain }: { domain: BinaryObject }): BinaryObjectDto => {
  const {
    id,
    mimeType,
    size,
    createdAt,
    name,
    ...unhandled
  } = domain;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<BinaryObjectDto>()({
    id: idToRaw({ id }),
    experimental: undefined,
    mimeType,
    size,
    createdAt,
    name,
  });
};


export const volumeToDomain = ({ dto }: { dto: VolumeDto }): Volume => {
  const {
    id,
    experimental: _experimental,
    name,
    type,
    createdAt,
    ...unhandled
  } = dto;

  unhandled satisfies Record<PropertyKey, never>;

  return exactObject<Volume>()({
    id: toVolumeId({ raw: id }),
    name,
    type,
    createdAt,
  });
};

export const volumeToDto = ({ domain }: { domain: Volume }): VolumeDto => {
  switch (domain.type) {
  case 'opfs': {
    const {
      type,
      id,
      name,
      createdAt,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<VolumeDto, { type: 'opfs' }>>()({
      type,
      experimental: undefined,
      id: idToRaw({ id }),
      name,
      createdAt,
    });
  }
  case 'host': {
    const {
      type,
      id,
      name,
      createdAt,
      ...unhandled
    } = domain;

    unhandled satisfies Record<PropertyKey, never>;

    return exactObject<Extract<VolumeDto, { type: 'host' }>>()({
      type,
      experimental: undefined,
      id: idToRaw({ id }),
      name,
      createdAt,
    });
  }
  default: {
    const _ex: never = domain.type;
    throw new Error(`Unhandled volume type: ${(_ex as { type: string }).type}`);
  }
  }
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
