/**
 * Purpose-specific branded ID types used throughout Naidan.
 *
 * Naidan uses dedicated branded types for identifiers regardless of whether
 * they are persisted, temporary, UI-only, or used for request correlation. ID
 * values remain primitive strings at runtime while TypeScript prevents them
 * from being used as raw strings implicitly.
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
export type GlobalEventId = BrandedId<'GlobalEventId'>;
export type VolumeCopyOperationId = BrandedId<'VolumeCopyOperationId'>;
export type EditableHistoryItemId = BrandedId<'EditableHistoryItemId'>;
export type RecipeImportCandidateId = BrandedId<'RecipeImportCandidateId'>;
export type RecipeModelPatternEditorItemId = BrandedId<'RecipeModelPatternEditorItemId'>;
export type PrivacyFetchRequestId = BrandedId<'PrivacyFetchRequestId'>;
export type ToolChoicesRequestId = BrandedId<'ToolChoicesRequestId'>;
export type ToolApprovalRequestId = BrandedId<'ToolApprovalRequestId'>;
export type OPFSTmpOwnerScopeId = BrandedId<'OPFSTmpOwnerScopeId'>;
export type OPFSTmpDirectoryId = BrandedId<'OPFSTmpDirectoryId'>;

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

export function toPrivacyFetchRequestId({ raw }: { raw: string }): PrivacyFetchRequestId {
  return raw as unknown as PrivacyFetchRequestId;
}

export function toOPFSTmpOwnerScopeId({ raw }: { raw: string }): OPFSTmpOwnerScopeId {
  return raw as unknown as OPFSTmpOwnerScopeId;
}

export function idToRaw({ id }: { id: NaidanId }): string {
  return id as unknown as string;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
