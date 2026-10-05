import { idToRaw, toNaidanRpcConnectionId, toNaidanRpcPeerId } from '@/01-models/ids';
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
  case 'local': {
    const { kind, ...unhandled } = location;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ExperimentalImageInferenceLocationPreferenceDto, { kind: 'local' }>>()({ kind });
  }
  case 'naidan_rpc': {
    const { kind, connection, ...unhandled } = location;
    unhandled satisfies Record<PropertyKey, never>;
    const mapped = connection && (() => {
      const { connectionId, peerId, ...unhandledConnection } = connection;
      unhandledConnection satisfies Record<PropertyKey, never>;
      return { connectionId: idToRaw({ id: connectionId }), peerId: idToRaw({ id: peerId }) };
    })();
    return exactObject<Extract<ExperimentalImageInferenceLocationPreferenceDto, { kind: 'naidan_rpc' }>>()({ kind, connection: mapped });
  }
  default: { const exhaustive: never = location; throw new Error(String(exhaustive)); }
  }
}

export function imageInferenceLocationToDomain({ dto }: { dto: ExperimentalImageInferenceLocationPreferenceDto }): ImageInferenceLocationPreference {
  switch (dto.kind) {
  case 'local': {
    const { kind, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<ImageInferenceLocationPreference, { kind: 'local' }>>()({ kind });
  }
  case 'naidan_rpc': {
    const { kind, connection, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    const mapped = connection && (() => {
      const { connectionId, peerId, ...unhandledConnection } = connection;
      unhandledConnection satisfies Record<PropertyKey, never>;
      return { connectionId: toNaidanRpcConnectionId({ raw: connectionId }), peerId: toNaidanRpcPeerId({ raw: peerId }) };
    })();
    return exactObject<Extract<ImageInferenceLocationPreference, { kind: 'naidan_rpc' }>>()({ kind, connection: mapped });
  }
  default: { const exhaustive: never = dto; throw new Error(String(exhaustive)); }
  }
}

export function remoteImageModelEditorPreferenceToDto({ preference }: { preference: RemoteImageModelEditorPreference }): ExperimentalRemoteImageModelEditorPreferenceDto {
  const { connectionId, peerId, editor, ...unhandled } = preference;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<ExperimentalRemoteImageModelEditorPreferenceDto>()({ connectionId: idToRaw({ id: connectionId }), peerId: idToRaw({ id: peerId }), editor: remoteImageModelEditorToDto({ editor }) });
}

export function remoteImageModelEditorPreferenceToDomain({ dto }: { dto: ExperimentalRemoteImageModelEditorPreferenceDto }): RemoteImageModelEditorPreference {
  const { connectionId, peerId, editor, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<RemoteImageModelEditorPreference>()({ connectionId: toNaidanRpcConnectionId({ raw: connectionId }), peerId: toNaidanRpcPeerId({ raw: peerId }), editor: remoteImageModelEditorToDomain({ dto: editor }) });
}

export const TEST_ONLY = {
};
