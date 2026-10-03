import type { SettingsDto } from '@/00-storage/00-dto/dto';
import type { BrowserImageModelLocation, BrowserImageModelSelection } from '@/01-models/types';
import { idToRaw, toHostModelDirectoryId } from '@/01-models/ids';
import { exactObject } from '@/utils/exact-object';

type BrowserImageGenerationDto = NonNullable<NonNullable<SettingsDto['experimental']>['browserImageGeneration']>;
type BrowserImageModelSelectionDto = NonNullable<BrowserImageGenerationDto['modelSelection']>;
type BrowserImageModelLocationDto = BrowserImageModelSelectionDto['primary']['location'];

const browserImageModelLocationToDomain = ({ dto }: { dto: BrowserImageModelLocationDto }): BrowserImageModelLocation => {
  switch (dto.kind) {
  case 'opfs': {
    const { kind, path, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<BrowserImageModelLocation, { kind: 'opfs' }>>()({ kind, path });
  }
  case 'host': {
    const { kind, directoryId, path, ...unhandled } = dto;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<BrowserImageModelLocation, { kind: 'host' }>>()({ kind, directoryId: toHostModelDirectoryId({ raw: directoryId }), path });
  }
  default: { const exhaustive: never = dto; throw new Error(String(exhaustive)); }
  }
};

const browserImageModelLocationToDto = ({ domain }: { domain: BrowserImageModelLocation }): BrowserImageModelLocationDto => {
  switch (domain.kind) {
  case 'opfs': {
    const { kind, path, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<BrowserImageModelLocationDto, { kind: 'opfs' }>>()({ kind, path });
  }
  case 'host': {
    const { kind, directoryId, path, ...unhandled } = domain;
    unhandled satisfies Record<PropertyKey, never>;
    return exactObject<Extract<BrowserImageModelLocationDto, { kind: 'host' }>>()({ kind, directoryId: idToRaw({ id: directoryId }), path });
  }
  default: { const exhaustive: never = domain; throw new Error(String(exhaustive)); }
  }
};

export const browserImageModelSelectionToDomain = ({ dto }: { dto: BrowserImageModelSelectionDto }): BrowserImageModelSelection => {
  const { primary, components, loras, ...unhandled } = dto;
  unhandled satisfies Record<PropertyKey, never>;
  const { slot, location, ...unhandledPrimary } = primary;
  unhandledPrimary satisfies Record<PropertyKey, never>;
  return exactObject<BrowserImageModelSelection>()({
    primary: exactObject<BrowserImageModelSelection['primary']>()({ slot, location: browserImageModelLocationToDomain({ dto: location }) }),
    components: components.map(({ slot, choice, ...unhandledComponent }) => {
      unhandledComponent satisfies Record<PropertyKey, never>;
      const mappedChoice: BrowserImageModelSelection['components'][number]['choice'] = (() => {
        switch (choice.kind) {
        case 'file': {
          const { kind, location, ...unhandledFile } = choice;
          unhandledFile satisfies Record<PropertyKey, never>;
          return exactObject<Extract<BrowserImageModelSelection['components'][number]['choice'], { kind: 'file' }>>()({ kind, location: browserImageModelLocationToDomain({ dto: location }) });
        }
        case 'none': {
          const { kind, ...unhandledNone } = choice;
          unhandledNone satisfies Record<PropertyKey, never>;
          return exactObject<Extract<BrowserImageModelSelection['components'][number]['choice'], { kind: 'none' }>>()({ kind });
        }
        default: { const exhaustive: never = choice; throw new Error(String(exhaustive)); }
        }
      })();
      return exactObject<BrowserImageModelSelection['components'][number]>()({ slot, choice: mappedChoice });
    }),
    loras: loras.map(({ location, enabled, strength, ...unhandledLora }) => {
      unhandledLora satisfies Record<PropertyKey, never>;
      return exactObject<BrowserImageModelSelection['loras'][number]>()({ location: browserImageModelLocationToDomain({ dto: location }), enabled, strength });
    }),
  });
};

export const browserImageModelSelectionToDto = ({ domain }: { domain: BrowserImageModelSelection }): BrowserImageModelSelectionDto => {
  const { primary, components, loras, ...unhandled } = domain;
  unhandled satisfies Record<PropertyKey, never>;
  const { slot, location, ...unhandledPrimary } = primary;
  unhandledPrimary satisfies Record<PropertyKey, never>;
  return exactObject<BrowserImageModelSelectionDto>()({
    primary: exactObject<BrowserImageModelSelectionDto['primary']>()({ slot, location: browserImageModelLocationToDto({ domain: location }) }),
    components: components.map(({ slot, choice, ...unhandledComponent }) => {
      unhandledComponent satisfies Record<PropertyKey, never>;
      const mappedChoice: BrowserImageModelSelectionDto['components'][number]['choice'] = (() => {
        switch (choice.kind) {
        case 'file': {
          const { kind, location, ...unhandledFile } = choice;
          unhandledFile satisfies Record<PropertyKey, never>;
          return exactObject<Extract<BrowserImageModelSelectionDto['components'][number]['choice'], { kind: 'file' }>>()({ kind, location: browserImageModelLocationToDto({ domain: location }) });
        }
        case 'none': {
          const { kind, ...unhandledNone } = choice;
          unhandledNone satisfies Record<PropertyKey, never>;
          return exactObject<Extract<BrowserImageModelSelectionDto['components'][number]['choice'], { kind: 'none' }>>()({ kind });
        }
        default: { const exhaustive: never = choice; throw new Error(String(exhaustive)); }
        }
      })();
      return exactObject<BrowserImageModelSelectionDto['components'][number]>()({ slot, choice: mappedChoice });
    }),
    loras: loras.map(({ location, enabled, strength, ...unhandledLora }) => {
      unhandledLora satisfies Record<PropertyKey, never>;
      return exactObject<BrowserImageModelSelectionDto['loras'][number]>()({ location: browserImageModelLocationToDto({ domain: location }), enabled, strength });
    }),
  });
};

export const TEST_ONLY = {
};
