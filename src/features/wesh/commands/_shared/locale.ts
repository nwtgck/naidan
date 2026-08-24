export type WeshCharacterLocaleMode = 'ascii' | 'unicode';

export function resolveCharacterLocaleMode({
  env,
}: {
  env: ReadonlyMap<string, string>,
}): WeshCharacterLocaleMode {
  const locale = env.get('LC_ALL')
    || env.get('LC_CTYPE')
    || env.get('LANG');
  return locale === 'C' || locale === 'POSIX' ? 'ascii' : 'unicode';
}

export function foldAsciiCase({ value }: { value: string }): string {
  return value.replace(/[A-Z]/gu, character => character.toLowerCase());
}

export function uppercaseAscii({ value }: { value: string }): string {
  return value.replace(/[a-z]/gu, character => character.toUpperCase());
}

export const TEST_ONLY = {
  foldAsciiCase,
  uppercaseAscii,
  resolveCharacterLocaleMode,
};
