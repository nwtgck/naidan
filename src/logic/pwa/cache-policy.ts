export const pwaRuntimeEngines = [
  'transformers-js', 'llama-cpp-browser', 'stable-diffusion-cpp-browser', 'speech-cpp-browser',
] as const;
export type PWARuntimeEngine = typeof pwaRuntimeEngines[number];

export type PWACacheRule =
  | { match: { basename: { prefix?: string; suffix: string } }; cache: 'never'; precacheFor?: never }
  | { match: { path: string }; cache: 'manual'; precacheFor?: never }
  | { match: { dedicatedTo: 'boundary-strings' }; precacheFor: 'app-locales'; cache?: never }
  | { match: { dedicatedTo: PWARuntimeEngine }; precacheFor: 'auto-selected-runtime'; cache?: never };

export const pwaCachePolicy = {
  default: 'precache',
  onUnknownSelection: 'precache-all-candidates',
  rules: [
    { match: { basename: { suffix: '.map' } }, cache: 'never' },
    { match: { basename: { prefix: 'naidan-standalone-', suffix: '.zip' } }, cache: 'never' },
    { match: { path: 'naidan-standalone.zip' }, cache: 'manual' },
    { match: { dedicatedTo: 'boundary-strings' }, precacheFor: 'app-locales' },
    { match: { dedicatedTo: 'transformers-js' }, precacheFor: 'auto-selected-runtime' },
    { match: { dedicatedTo: 'llama-cpp-browser' }, precacheFor: 'auto-selected-runtime' },
    { match: { dedicatedTo: 'stable-diffusion-cpp-browser' }, precacheFor: 'auto-selected-runtime' },
    { match: { dedicatedTo: 'speech-cpp-browser' }, precacheFor: 'auto-selected-runtime' },
  ],
} as const satisfies { default: 'precache'; onUnknownSelection: 'precache-all-candidates'; rules: readonly PWACacheRule[] };

export const permanentCacheExclusions: readonly Extract<PWACacheRule, { cache: 'never' }>[] =
  pwaCachePolicy.rules.filter(rule => 'cache' in rule && rule.cache === 'never');

export function matchesPermanentCacheExclusion({ file, rule }: {
  file: string;
  rule: (typeof permanentCacheExclusions)[number];
}): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const { prefix = '', suffix } = rule.match.basename;
  return name.length >= prefix.length + suffix.length && name.startsWith(prefix) && name.endsWith(suffix);
}

export const TEST_ONLY = {
};
