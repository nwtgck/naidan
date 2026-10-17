import { lazyStrings } from '@/strings';
export type SettingsSource = 'chat' | 'chat_group' | 'global';

/**
 * Formats a settings value for reactive rendering. Boundary Strings may be
 * unresolved on the first evaluation, so callers must keep this result in a
 * template or computed path that will be evaluated again.
 */
export function formatSettingsSourceLabel({
  value,
  source,
}: {
  value: string | undefined,
  source: SettingsSource | undefined,
}): string | undefined {
  const resolvedValue = value || lazyStrings.formatSettingsSourceLabel__none();
  if (resolvedValue === undefined) {
    return undefined;
  }
  switch (source) {
  case 'chat':
    return lazyStrings.formatSettingsSourceLabel__value_from_chat({ value: resolvedValue });
  case 'chat_group':
    return lazyStrings.formatSettingsSourceLabel__value_from_group({ value: resolvedValue });
  case 'global':
    return lazyStrings.formatSettingsSourceLabel__value_from_global({ value: resolvedValue });
  case undefined:
    return resolvedValue;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled source: ${_ex}`);
  }
  }
}

/** Presentation only: owners still choose which raw reference/source is active. */
export function settingsSourcePresentation({ source }: { source: SettingsSource | undefined }): { label: string | undefined, description: string | undefined } | undefined {
  let label: string | undefined;
  switch (source) {
  case 'global': label = lazyStrings.SettingsSourceBadge__global();
    break;
  case 'chat_group': label = lazyStrings.SettingsSourceBadge__chat_group();
    break;
  case 'chat': label = lazyStrings.SettingsSourceBadge__same_chat();
    break;
  case undefined: return undefined;
  default: {
    const _ex: never = source;
    return _ex;
  }
  }
  return { label, description: lazyStrings.SettingsSourceBadge__follows_changes_to_source({ source: label }) };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
