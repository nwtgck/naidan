import type { ImageLora } from './types';

/** Temporary UI selections. Disabling an adapter preserves its editable strength. */
export type ImageLoraSelection = ImageLora & { enabled: boolean, sourceLabel?: string };

export function imageLoraRequests({ selections }: { selections: readonly ImageLoraSelection[] }): ImageLora[] {
  return selections.map(({ file, path, strength, enabled, sourceLabel: _sourceLabel, ...unhandled }) => {
    unhandled satisfies Record<PropertyKey, never>;
    return { file, path, strength: enabled ? strength : 0 };
  });
}

export const TEST_ONLY = {
};
