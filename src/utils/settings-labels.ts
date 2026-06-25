export type SettingsSource = 'chat' | 'chat_group' | 'global';

export function formatSettingsSourceLabel({
  value,
  source,
}: {
  value: string | undefined,
  source: SettingsSource | undefined,
}) {
  if (!value) return 'Default';
  switch (source) {
  case 'chat_group':
    return `${value} (Group)`;
  case 'global':
    return `${value} (Global)`;
  case 'chat':
  case undefined:
    return value;
  default: {
    const _ex: never = source;
    throw new Error(`Unhandled source: ${_ex}`);
  }
  }
}
