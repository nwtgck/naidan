export const STANDALONE_FACADES = [
  {
    facadePath: '@/services/transformers-js/provider',
    standalonePath: 'src/services/transformers-js/provider-standalone.ts',
  },
  {
    facadePath: '@/services/transformers-js',
    standalonePath: 'src/services/transformers-js/index-standalone.ts',
  },
  {
    facadePath: '@/services/advanced-text-editor-v3/worker/client',
    standalonePath: 'src/services/advanced-text-editor-v3/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/highlight/worker/client',
    standalonePath: 'src/services/highlight/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/wesh/worker/client',
    standalonePath: 'src/services/wesh/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/global-search/worker/client',
    standalonePath: 'src/services/global-search/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/file-explorer/worker/client',
    standalonePath: 'src/services/file-explorer/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/transformers-js/worker/client',
    standalonePath: 'src/services/transformers-js/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/transformers-js/scanner/worker/client',
    standalonePath: 'src/services/transformers-js/scanner/worker/client-standalone.ts',
  },
  {
    facadePath: '@/services/privacy-fetch',
    standalonePath: 'src/services/privacy-fetch/index-standalone.ts',
  },
  {
    facadePath: '@/services/fake-lm',
    standalonePath: 'src/services/fake-lm/index-standalone.ts',
  },
];

export const STANDALONE_WORKER_CLIENT_FACADES = [
  '@/services/advanced-text-editor-v3/worker/client',
  '@/services/highlight/worker/client',
  '@/services/wesh/worker/client',
  '@/services/global-search/worker/client',
  '@/services/file-explorer/worker/client',
  '@/services/transformers-js/worker/client',
  '@/services/transformers-js/scanner/worker/client',
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
