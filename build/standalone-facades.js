export const STANDALONE_FACADES = [
  {
    facadePath: '@/features/transformers-js/provider',
    standalonePath: 'src/features/transformers-js/provider-standalone.ts',
  },
  {
    facadePath: '@/features/transformers-js',
    standalonePath: 'src/features/transformers-js/index-standalone.ts',
  },
  {
    facadePath: '@/features/advanced-text-editor-v3/worker/client',
    standalonePath: 'src/features/advanced-text-editor-v3/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/highlight/worker/client',
    standalonePath: 'src/features/highlight/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/wesh/worker/client',
    standalonePath: 'src/features/wesh/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/global-search/worker/client',
    standalonePath: 'src/features/global-search/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/file-explorer/worker/client',
    standalonePath: 'src/features/file-explorer/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/transformers-js/worker/client',
    standalonePath: 'src/features/transformers-js/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/transformers-js/scanner/worker/client',
    standalonePath: 'src/features/transformers-js/scanner/worker/client-standalone.ts',
  },
  {
    facadePath: '@/features/privacy-fetch',
    standalonePath: 'src/features/privacy-fetch/index-standalone.ts',
  },
  {
    facadePath: '@/features/fake-lm',
    standalonePath: 'src/features/fake-lm/index-standalone.ts',
  },
];

export const STANDALONE_WORKER_CLIENT_FACADES = [
  '@/features/advanced-text-editor-v3/worker/client',
  '@/features/highlight/worker/client',
  '@/features/wesh/worker/client',
  '@/features/global-search/worker/client',
  '@/features/file-explorer/worker/client',
  '@/features/transformers-js/worker/client',
  '@/features/transformers-js/scanner/worker/client',
];

function escapeRegExp({ value }) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createExactAliasFindRegExp({ facadePath }) {
  return new RegExp(`^${escapeRegExp({ value: facadePath })}$`);
}

export function createStandaloneFacadeAliases({ resolvePath }) {
  return STANDALONE_FACADES.map(({
    facadePath,
    standalonePath,
  }) => ({
    find: createExactAliasFindRegExp({ facadePath }),
    replacement: resolvePath(standalonePath),
  }));
}
