import { lazyStrings } from '@/strings';
export type SettingsSource = 'chat' | 'chat_group' | 'global';

export function formatSettingsSourceLabel({
  value,
  source,
}: {
  value: string | undefined,
  source: SettingsSource | undefined,
}) {
  if (!value) return lazyStrings.SHARED__default();
  switch (source) {
  case 'chat_group':
    return lazyStrings.SHARED__value_from_group({ value });
  case 'global':
    return lazyStrings.SHARED__value_from_global({ value });
  case 'chat':
  case undefined:
    return value;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled source: ${_ex}`);
  }
  }
}
