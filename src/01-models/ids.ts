/**
 * Branded ID types for Naidan domain models.
 *
 * Naidan intentionally keeps ID values as primitive strings at runtime while
 * preventing them from being used as raw strings implicitly in TypeScript.
 *
 * Do not define this as `string & { readonly [idBrand]: TName }`.
 * If BrandedId extends string, raw string boundaries such as DTOs, storage
 * paths, URL params, Vue keys, DOM ids, and worker payloads become invisible
 * in review because `const raw: string = chatId` compiles.
 */
export declare const idBrand: unique symbol;

type BrandedId<TName extends string> =
  // ID values are primitive strings at runtime, but this intentionally
  // object-shaped type prevents implicit assignment to raw strings. Keep the
  // @vue-ignore directive attached here; otherwise Vue infers Object for ID
  // props and rejects valid primitive string values.
  /* @vue-ignore */
  {
    readonly [idBrand]: TName,
  };

export type ChatId = BrandedId<'ChatId'>;
export type MessageId = BrandedId<'MessageId'>;
export type ChatGroupId = BrandedId<'ChatGroupId'>;
export type AttachmentId = BrandedId<'AttachmentId'>;
export type BinaryObjectId = BrandedId<'BinaryObjectId'>;
export type VolumeId = BrandedId<'VolumeId'>;
export type ProviderProfileId = BrandedId<'ProviderProfileId'>;
export type ToolCallId = BrandedId<'ToolCallId'>;

export type NaidanId = BrandedId<string>;

export function toChatId({ raw }: { raw: string }): ChatId {
  return raw as unknown as ChatId;
}

export function toMessageId({ raw }: { raw: string }): MessageId {
  return raw as unknown as MessageId;
}

export function toChatGroupId({ raw }: { raw: string }): ChatGroupId {
  return raw as unknown as ChatGroupId;
}

export function toAttachmentId({ raw }: { raw: string }): AttachmentId {
  return raw as unknown as AttachmentId;
}

export function toBinaryObjectId({ raw }: { raw: string }): BinaryObjectId {
  return raw as unknown as BinaryObjectId;
}

export function toVolumeId({ raw }: { raw: string }): VolumeId {
  return raw as unknown as VolumeId;
}

export function toProviderProfileId({ raw }: { raw: string }): ProviderProfileId {
  return raw as unknown as ProviderProfileId;
}

export function toToolCallId({ raw }: { raw: string }): ToolCallId {
  return raw as unknown as ToolCallId;
}

export function idToRaw({ id }: { id: NaidanId }): string {
  return id as unknown as string;
}
