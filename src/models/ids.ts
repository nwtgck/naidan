/**
 * Branded ID types for Naidan domain models.
 *
 * Persisted DTOs keep IDs as plain strings. Domain code uses these branded
 * string types to prevent mixing IDs that share the same runtime shape but
 * point to different entities.
 */
declare const idBrand: unique symbol;

type BrandedId<TName extends string> = string & {
  readonly [idBrand]: TName;
};

export type ChatId = BrandedId<'ChatId'>;
export type MessageId = BrandedId<'MessageId'>;
export type ChatGroupId = BrandedId<'ChatGroupId'>;
export type AttachmentId = BrandedId<'AttachmentId'>;
export type BinaryObjectId = BrandedId<'BinaryObjectId'>;
export type VolumeId = BrandedId<'VolumeId'>;
export type ProviderProfileId = BrandedId<'ProviderProfileId'>;
export type ToolCallId = BrandedId<'ToolCallId'>;

export type NaidanId =
  | ChatId
  | MessageId
  | ChatGroupId
  | AttachmentId
  | BinaryObjectId
  | VolumeId
  | ProviderProfileId
  | ToolCallId;

export function toChatId({ raw }: { raw: string }): ChatId {
  return raw as ChatId;
}

export function toMessageId({ raw }: { raw: string }): MessageId {
  return raw as MessageId;
}

export function toChatGroupId({ raw }: { raw: string }): ChatGroupId {
  return raw as ChatGroupId;
}

export function toAttachmentId({ raw }: { raw: string }): AttachmentId {
  return raw as AttachmentId;
}

export function toBinaryObjectId({ raw }: { raw: string }): BinaryObjectId {
  return raw as BinaryObjectId;
}

export function toVolumeId({ raw }: { raw: string }): VolumeId {
  return raw as VolumeId;
}

export function toProviderProfileId({ raw }: { raw: string }): ProviderProfileId {
  return raw as ProviderProfileId;
}

export function toToolCallId({ raw }: { raw: string }): ToolCallId {
  return raw as ToolCallId;
}
