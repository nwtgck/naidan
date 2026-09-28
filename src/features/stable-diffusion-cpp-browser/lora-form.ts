import type { ImageLora } from './types';

/** Temporary UI selections. Disabling an adapter preserves its editable strength. */
export type ImageLoraSelection = ImageLora & { enabled: boolean, sourceLabel?: string };

/** Only enabled selections reach validation, session identity and native mounts.
 * An enabled adapter with zero strength still keeps its existing session behavior. */
export function imageLoraRequests({ selections }: { selections: readonly ImageLoraSelection[] }): ImageLora[] {
  return imageLoraHistorySelections({ selections: selections.filter(selection => selection.enabled) });
}

/** Preserve the existing history representation without reading adapter bytes.
 * Disabled selections use zero strength in history; they are not inference inputs. */
export function imageLoraHistorySelections({ selections }: { selections: readonly ImageLoraSelection[] }): ImageLora[] {
  return selections.map(({ file, path, strength, enabled, sourceLabel: _sourceLabel, ...unhandled }) => {
    unhandled satisfies Record<PropertyKey, never>;
    return { file, path, strength: enabled ? strength : 0 };
  });
}

export const TEST_ONLY = {
};
