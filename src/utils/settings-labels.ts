// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this UI label helper into application logic.
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
  if (!value) return lazyStrings.formatSettingsSourceLabel__default();
  switch (source) {
  case 'chat_group':
    return lazyStrings.formatSettingsSourceLabel__value_from_group({ value });
  case 'global':
    return lazyStrings.formatSettingsSourceLabel__value_from_global({ value });
  case 'chat':
  case undefined:
    return value;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled source: ${_ex}`);
  }
  }
}
