import { retainRpcLeaf, retainedRpcLeaf } from '@/00-storage/00-dto/retained-rpc';
import { idToRaw, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { ImageInferenceLocationPreference, RemoteImageModelEditor, RemoteImageModelEditorPreferenceValue } from '@/01-models/image-generation-preferences';
import { exactObject } from '@/utils/exact-object';
import { ExperimentalRemoteImageModelEditorSchemaDto } from '@/00-storage/00-dto/experimental.dto';
import type { ExperimentalImageInferenceLocationPreferenceDto, ExperimentalRemoteImageModelEditorPreferenceDto, ExperimentalRemoteImageModelEditorDto } from '@/00-storage/00-dto/experimental.dto';

export function remoteImageModelEditorToDto({ editor }: { editor: RemoteImageModelEditor }): ExperimentalRemoteImageModelEditorDto {
  const { primary, components, loras, ...unhandled } = editor;
  unhandled satisfies Record<PropertyKey, never>;
  return ExperimentalRemoteImageModelEditorSchemaDto.parse(exactObject<ExperimentalRemoteImageModelEditorDto>()({ primary, components, loras }));
}

export function remoteImageModelEditorToDomain({ dto }: { dto: ExperimentalRemoteImageModelEditorDto }): RemoteImageModelEditor {
  const { primary, components, loras, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<RemoteImageModelEditor>()(ExperimentalRemoteImageModelEditorSchemaDto.parse({ primary, components, loras }));
}

export function imageInferenceLocationToDto({ location }: { location: ImageInferenceLocationPreference }): ExperimentalImageInferenceLocationPreferenceDto {
  switch (location.kind) {
  case 'local': {
    const { kind, ...unhandled } = location;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalImageInferenceLocationPreferenceDto, { kind: 'local' }>>()({ kind });
  }
  case 'naidan_rpc': {
    const { kind, registration, unavailableRpc, ...unhandled } = location;
    if (unavailableRpc !== undefined) return retainRpcLeaf({ value: { kind, registration: undefined }, raw: unavailableRpc });
    unhandled satisfies Record<PropertyKey, never>;
    const mapped = registration && (() => {
      const { registrationId, peerPublicKey, ...unhandledRegistration } = registration;
      unhandledRegistration satisfies Record<PropertyKey, never>;
      return { registrationId: idToRaw({ id: registrationId }), peerPublicKey: idToRaw({ id: peerPublicKey }) };
    })();
    return exactObject<Extract<ExperimentalImageInferenceLocationPreferenceDto, { kind: 'naidan_rpc' }>>()({ kind, registration: mapped });
  }
  default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
  }
}

export function imageInferenceLocationToDomain({ dto }: { dto: ExperimentalImageInferenceLocationPreferenceDto }): ImageInferenceLocationPreference {
  const retained = retainedRpcLeaf({ value: dto });
  if (retained !== undefined) return { kind: 'naidan_rpc', registration: undefined, unavailableRpc: retained.copy() };
  switch (dto.kind) {
  case 'local': {
    const { kind, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ImageInferenceLocationPreference, { kind: 'local' }>>()({ kind });
  }
  case 'naidan_rpc': {
    const { kind, registration, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    const mapped = registration && (() => {
      const { registrationId, peerPublicKey, ...unhandledRegistration } = registration;
      unhandledRegistration satisfies Record<PropertyKey, never>;
      return { registrationId: toNaidanRpcRegistrationId({ raw: registrationId }), peerPublicKey: toNaidanRpcPeerPublicKey({ raw: peerPublicKey }) };
    })();
    return exactObject<Extract<ImageInferenceLocationPreference, { kind: 'naidan_rpc', unavailableRpc?: never }>>()({ kind, registration: mapped, unavailableRpc: undefined });
  }
  default: { const exhaustive: never = dto; throw new Error(String(exhaustive)); }
  }
}

export function remoteImageModelEditorPreferenceToDto({ preference }: { preference: RemoteImageModelEditorPreferenceValue }): ExperimentalRemoteImageModelEditorPreferenceDto {
  if ('unavailableRpc' in preference) return retainRpcLeaf({ value: { unavailableRpc: preference.unavailableRpc.copy() }, raw: preference.unavailableRpc });
  const { registrationId, peerPublicKey, editor, ...unhandled } = preference;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<Exclude<ExperimentalRemoteImageModelEditorPreferenceDto, { unavailableRpc: unknown }>>()({ registrationId: idToRaw({ id: registrationId }), peerPublicKey: idToRaw({ id: peerPublicKey }), editor: remoteImageModelEditorToDto({ editor }) });
}

export function remoteImageModelEditorPreferenceToDomain({ dto }: { dto: ExperimentalRemoteImageModelEditorPreferenceDto }): RemoteImageModelEditorPreferenceValue {
  if ('unavailableRpc' in dto) return { unavailableRpc: dto.unavailableRpc.copy() };
  const { registrationId, peerPublicKey, editor, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<Exclude<RemoteImageModelEditorPreferenceValue, { unavailableRpc: unknown }>>()({ registrationId: toNaidanRpcRegistrationId({ raw: registrationId }), peerPublicKey: toNaidanRpcPeerPublicKey({ raw: peerPublicKey }), editor: remoteImageModelEditorToDomain({ dto: editor }) });
}

export const TEST_ONLY = {
};
