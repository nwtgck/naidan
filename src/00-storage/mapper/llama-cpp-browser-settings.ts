import type { SettingsDto } from '@/00-storage/00-dto/dto';
import type { LlamaCppBrowserSettings } from '@/01-models/types';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';

type LlamaCppBrowserSettingsDto = NonNullable<NonNullable<SettingsDto['experimental']>['llamaCppBrowser']>;
type ModelDownloadDestination = NonNullable<LlamaCppBrowserSettings['modelDownloadDestination']>;
type ModelDownloadDestinationDto = NonNullable<LlamaCppBrowserSettingsDto['modelDownloadDestination']>;

export const llamaCppBrowserSettingsToDomain = ({ dto }: { dto: LlamaCppBrowserSettingsDto | undefined }): LlamaCppBrowserSettings | undefined => {
  if (dto === undefined) return undefined;
  const { modelDownloadDestination, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;

  const destination = (() => {
    if (modelDownloadDestination === undefined) return undefined;
    switch (modelDownloadDestination.kind) {
    case 'opfs': {
      const { kind, ...unhandledDestination } = modelDownloadDestination;
      unhandledDestination satisfies Record<PropertyKey, never>;
      return exactObject<Extract<ModelDownloadDestination, { kind: 'opfs' }>>()({ kind });
    }
    case 'host': {
      const { kind, directoryId, ...unhandledDestination } = modelDownloadDestination;
      unhandledDestination satisfies Record<PropertyKey, never>;
      return exactObject<Extract<ModelDownloadDestination, { kind: 'host' }>>()({ kind, directoryId: toHostModelDirectoryId({ raw: directoryId }) });
    }
    default: { const exhaustive: never = modelDownloadDestination; throw new Error(String(exhaustive)); }
    }
  })();

  return exactObject<LlamaCppBrowserSettings>()({ modelDownloadDestination: destination });
};

export const llamaCppBrowserSettingsToDto = ({ domain }: { domain: LlamaCppBrowserSettings | undefined }): LlamaCppBrowserSettingsDto | undefined => {
  if (domain === undefined) return undefined;
  const { modelDownloadDestination, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;

  const destination = (() => {
    if (modelDownloadDestination === undefined) return undefined;
    switch (modelDownloadDestination.kind) {
    case 'opfs': {
      const { kind, ...unhandledDestination } = modelDownloadDestination;
      unhandledDestination satisfies Record<PropertyKey, never>;
      return exactObject<Extract<ModelDownloadDestinationDto, { kind: 'opfs' }>>()({ kind });
    }
    case 'host': {
      const { kind, directoryId, ...unhandledDestination } = modelDownloadDestination;
      unhandledDestination satisfies Record<PropertyKey, never>;
      return exactObject<Extract<ModelDownloadDestinationDto, { kind: 'host' }>>()({ kind, directoryId: idToRaw({ id: directoryId }) });
    }
    default: { const exhaustive: never = modelDownloadDestination; throw new Error(String(exhaustive)); }
    }
  })();

  return exactObject<LlamaCppBrowserSettingsDto>()({ modelDownloadDestination: destination });
};

export const TEST_ONLY = {
};
