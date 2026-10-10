import { idToRaw, toNaidanRpcRegistrationId, toNaidanRpcPeerPublicKey } from '@/01-models/ids';
import type { ImageInferenceLocationPreference, RemoteImageModelEditor, RemoteImageModelEditorPreference } from '@/01-models/image-generation-preferences';
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
  case 'local': case 'unavailable': {
    const { kind, ...unhandled } = location;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalImageInferenceLocationPreferenceDto, { kind: 'local' | 'unavailable' }>>()({ kind });
  }
  case 'naidan_rpc': {
    const { kind, registration, ...unhandled } = location;
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
  switch (dto.kind) {
  case 'local': case 'unavailable': {
    const { kind, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ImageInferenceLocationPreference, { kind: 'local' | 'unavailable' }>>()({ kind });
  }
  case 'naidan_rpc': {
    const { kind, registration, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    if (registration && (!/^[A-Za-z0-9_-]{8,128}$/.test(registration.registrationId) || !/^[A-Za-z0-9_-]{43}$/.test(registration.peerPublicKey))) return { kind: 'unavailable' };
    let mapped: Extract<ImageInferenceLocationPreference, { kind: 'naidan_rpc' }>['registration'];
    try {
      mapped = registration && { registrationId: toNaidanRpcRegistrationId({ raw: registration.registrationId }), peerPublicKey: toNaidanRpcPeerPublicKey({ raw: registration.peerPublicKey }) };
    } catch {
      return { kind: 'unavailable' };
    }
    return exactObject<Extract<ImageInferenceLocationPreference, { kind: 'naidan_rpc' }>>()({ kind, registration: mapped });
  }
  default: { const exhaustive: never = dto; throw new Error(String(exhaustive)); }
  }
}

export function remoteImageModelEditorPreferenceToDto({ preference }: { preference: RemoteImageModelEditorPreference }): ExperimentalRemoteImageModelEditorPreferenceDto {
  const { registrationId, peerPublicKey, editor, ...unhandled } = preference;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalRemoteImageModelEditorPreferenceDto>()({ registrationId: idToRaw({ id: registrationId }), peerPublicKey: idToRaw({ id: peerPublicKey }), editor: remoteImageModelEditorToDto({ editor }) });
}

export function remoteImageModelEditorPreferenceToDomain({ dto }: { dto: ExperimentalRemoteImageModelEditorPreferenceDto }): RemoteImageModelEditorPreference | undefined {
  const { registrationId, peerPublicKey, editor, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(registrationId) || !/^[A-Za-z0-9_-]{43}$/.test(peerPublicKey)) return undefined;
  try {
    return exactObject<RemoteImageModelEditorPreference>()({ registrationId: toNaidanRpcRegistrationId({ raw: registrationId }), peerPublicKey: toNaidanRpcPeerPublicKey({ raw: peerPublicKey }), editor: remoteImageModelEditorToDomain({ dto: editor }) });
  } catch {
    return undefined;
  }
}

export const TEST_ONLY = {
};
